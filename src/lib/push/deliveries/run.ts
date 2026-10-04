/**
 * 通知 段階4b・4c: 定期実行の1回分(設計書 §7.3)。systemd timer から数分ごとに呼ばれる。
 * 記録を作る(編集権限が外れた・査定申込・謄本ジョブ・次回対応)→ 送る → 古い記録を消す、の順。
 * 戻り値は件数だけ(中身・宛先は出さない)。
 */
import prisma from "@/lib/prisma";
import { REREAD_WINDOW_MS } from "@/lib/notifications/event-cursor";
import { loadSourceRecipients, planEditLockLossDeliveries, planNextActionDeliveries, planSourceDeliveries } from "./plan";
import { sendDueDeliveries, type SendResult } from "./send";
import {
  NEXT_ACTION_PLAN_BUDGET_MS,
  PURGE_BATCH,
  RECORD_RETENTION_MS,
  SEND_RUN_BUDGET_MS,
  SOURCE_PLAN_BUDGET_MS,
  SOURCE_PLAN_TX_TIMEOUT_MS,
  SOURCES,
  type Source,
} from "./rules";
import type { PushSender } from "./web-push-sender";

export interface PushRunResult {
  planned: { nextAction: number; inquiry: number; registryJob: number; editLockLost: number };
  sent: Record<SendResult, number>;
  purged: { deliveries: number; events: number; editLockLosses: number };
}

export async function runPushNotifications(now: Date, sender: PushSender): Promise<PushRunResult> {
  const startedAtMs = Date.now();
  // 1回分の持ち時間。記録づくりも送信も、過ぎたら新しく始めない(curl の時間制限より先に終わる)。
  const deadlineMs = startedAtMs + SEND_RUN_BUDGET_MS;
  const pastDeadline = () => Date.now() >= deadlineMs;
  // 編集権限が外れた知らせは1時間で送れなくなるので最初に分ける(ほかの溜まった分に持ち時間を
  // 使い切られて、時間切れで捨てることにならないように・@codex #473 P2)。件数は上限200で小さい。
  const editLockLost = await planEditLockLossDeliveries(now);
  // 申込・謄本ジョブはカーソルの行が無ければ(migration 前)例外=送らずに失敗で終わる(§7.6)。
  // 持ち時間を過ぎて飛ばしてもカーソルは進まないので、次の実行で同じ所から読む(取りこぼさない)。
  // 2つの出来事を交互に1回分(1トランザクション)ずつ進め、使ってよいのは始めから90秒まで(片方の
  // 溜まりでもう片方や次回対応を止めない)。送り先になれる人は1回分ごとに、トランザクションの外で
  // 求め直す(権限の確かめを外に出しつつ、見つけた時点に近い顔ぶれで送り先を決める)。
  const sourceDeadlineMs = Math.min(deadlineMs, startedAtMs + SOURCE_PLAN_BUDGET_MS);
  const created: Record<Source, number> = { inquiry: 0, registry_job: 0 };
  // どちらから始めるかは、カーソルを最後に進めたのが古い方から(進めるたびに更新される=DB に残る順番)。
  // 片方の溜まりで毎回もう片方の番が来ない、を防ぐ(実行の間隔によらない・@codex #472 P2)。
  const cursorRows = await prisma.notificationSourceCursor.findMany({ select: { source: true, updatedAt: true } });
  const touched = new Map(cursorRows.map((c) => [c.source, c.updatedAt.getTime()]));
  let pending: Source[] = [...SOURCES].sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
  // 1回分(1トランザクション)は最大 SOURCE_PLAN_TX_TIMEOUT_MS かかるので、その分を残して始める。
  const canStartSource = () => Date.now() + SOURCE_PLAN_TX_TIMEOUT_MS < sourceDeadlineMs;
  while (pending.length > 0 && canStartSource()) {
    const next: Source[] = [];
    for (const s of pending) {
      if (!canStartSource()) break;
      const recipients = await loadSourceRecipients(s, sourceDeadlineMs);
      // 顔ぶれを求めている間に残り時間が減っていたら、トランザクションは始めない(@codex #472 P2)。
      if (!recipients || !canStartSource()) break;
      const r = await planSourceDeliveries(s, now, recipients);
      created[s] += r.created;
      if (r.more) next.push(s);
    }
    pending = next;
  }
  const inquiry = created.inquiry;
  const registryJob = created.registry_job;
  // 次回対応の記録づくりは始めから120秒まで(送信に30秒以上を残す)。
  const nextActionDeadlineMs = Math.min(deadlineMs, startedAtMs + NEXT_ACTION_PLAN_BUDGET_MS);
  // 回の判定は記録づくりを始める今の時刻で(出来事の記録づくりの間に来た 9:00・5分前の回を落とさない・@codex #472 P2)。
  const nextActionNow = new Date(Math.max(now.getTime(), Date.now()));
  const nextAction =
    Date.now() >= nextActionDeadlineMs ? 0 : await planNextActionDeliveries(nextActionNow, { deadlineMs: nextActionDeadlineMs });
  const sent = await sendDueDeliveries(now, sender, { startedAtMs });
  // 古い記録の片付けは持ち時間の内側で、1回に1,000件まで(残りは次の実行で・@codex #472 P2)。
  const purged = pastDeadline() ? { deliveries: 0, events: 0, editLockLosses: 0 } : await purgeOldRecords(now);
  return { planned: { nextAction, inquiry, registryJob, editLockLost }, sent, purged };
}

async function purgeOldRecords(now: Date): Promise<{ deliveries: number; events: number; editLockLosses: number }> {
  const before = new Date(now.getTime() - RECORD_RETENTION_MS);
  const oldDeliveries = await prisma.notificationDelivery.findMany({
    where: { createdAt: { lt: before }, status: { in: ["sent", "failed", "gone", "cancelled"] } },
    select: { id: true },
    take: PURGE_BATCH,
  });
  // 「見つけ済み」の印は、その出来事がもう読み直しの範囲(カーソルの5分前から)に入らないときだけ消す
  // (申込などが長く来ずカーソルが進まないと、30日たっても範囲に残り、消すと二重に知らせるため・@codex #472 P2)。
  // 出来事そのものが消えている印も消してよい。
  const oldEvents = await prisma.$queryRaw<Array<{ source: string; eventId: string }>>`
    SELECT ev."source", ev."event_id" AS "eventId"
    FROM "notification_source_events" ev
    JOIN "notification_source_cursors" c ON c."source" = ev."source"
    LEFT JOIN "dm_inquiries" q ON ev."source" = 'inquiry' AND q."id" = ev."event_id"
    LEFT JOIN "registry_fetch_jobs" j ON ev."source" = 'registry_job' AND j."id" = ev."event_id"
    WHERE ev."first_seen_at" < ${before.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      AND (
        (ev."source" = 'inquiry' AND (q."id" IS NULL OR q."submitted_at" < c."cursor_t" - make_interval(secs => ${REREAD_WINDOW_MS / 1000}::double precision)))
        OR (ev."source" = 'registry_job' AND (j."id" IS NULL OR j."completed_at" IS NULL OR j."completed_at" < c."cursor_t" - make_interval(secs => ${REREAD_WINDOW_MS / 1000}::double precision)))
      )
    LIMIT ${PURGE_BATCH}`;
  // 知らせ終わった外れた記録も30日で消す(設計書 §7.2)。
  const oldLosses = await prisma.editLockLossEvent.findMany({
    where: { createdAt: { lt: before }, status: { in: ["queued", "expired"] } },
    select: { id: true },
    take: PURGE_BATCH,
  });
  const deliveries = oldDeliveries.length
    ? await prisma.notificationDelivery.deleteMany({ where: { id: { in: oldDeliveries.map((d) => d.id) } } })
    : { count: 0 };
  const events = oldEvents.length
    ? await prisma.notificationSourceEvent.deleteMany({ where: { OR: oldEvents.map((e) => ({ source: e.source, eventId: e.eventId })) } })
    : { count: 0 };
  const losses = oldLosses.length
    ? await prisma.editLockLossEvent.deleteMany({ where: { id: { in: oldLosses.map((l) => l.id) } } })
    : { count: 0 };
  return { deliveries: deliveries.count, events: events.count, editLockLosses: losses.count };
}
