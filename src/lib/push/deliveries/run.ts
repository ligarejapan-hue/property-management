/**
 * 通知 段階4b: 定期実行の1回分(設計書 §7.3)。systemd timer から数分ごとに呼ばれる。
 * 記録を作る(次回対応・査定申込・謄本ジョブ)→ 送る → 古い記録を消す、の順。
 * 戻り値は件数だけ(中身・宛先は出さない)。
 */
import prisma from "@/lib/prisma";
import { planNextActionDeliveries, planSourceDeliveries } from "./plan";
import { sendDueDeliveries, type SendResult } from "./send";
import { PURGE_BATCH, RECORD_RETENTION_MS, SEND_RUN_BUDGET_MS, SOURCES } from "./rules";
import type { PushSender } from "./web-push-sender";

export interface PushRunResult {
  planned: { nextAction: number; inquiry: number; registryJob: number };
  sent: Record<SendResult, number>;
  purged: { deliveries: number; events: number };
}

export async function runPushNotifications(now: Date, sender: PushSender): Promise<PushRunResult> {
  const startedAtMs = Date.now();
  // 1回分の持ち時間。記録づくりも送信も、過ぎたら新しく始めない(curl の時間制限より先に終わる)。
  const deadlineMs = startedAtMs + SEND_RUN_BUDGET_MS;
  const pastDeadline = () => Date.now() >= deadlineMs;
  // 申込・謄本ジョブはカーソルの行が無ければ(migration 前)例外=送らずに失敗で終わる(§7.6)。
  // 持ち時間を過ぎて飛ばしてもカーソルは進まないので、次の実行で同じ所から読む(取りこぼさない)。
  const [inquiry, registryJob] = await (async () => {
    const out: number[] = [];
    for (const s of SOURCES) out.push(pastDeadline() ? 0 : await planSourceDeliveries(s, now));
    return out;
  })();
  const nextAction = pastDeadline() ? 0 : await planNextActionDeliveries(now, { deadlineMs });
  const sent = await sendDueDeliveries(now, sender, { startedAtMs });
  // 古い記録の片付けは持ち時間の内側で、1回に1,000件まで(残りは次の実行で・@codex #472 P2)。
  const purged = pastDeadline() ? { deliveries: 0, events: 0 } : await purgeOldRecords(now);
  return { planned: { nextAction, inquiry, registryJob }, sent, purged };
}

async function purgeOldRecords(now: Date): Promise<{ deliveries: number; events: number }> {
  const before = new Date(now.getTime() - RECORD_RETENTION_MS);
  const oldDeliveries = await prisma.notificationDelivery.findMany({
    where: { createdAt: { lt: before }, status: { in: ["sent", "failed", "gone", "cancelled"] } },
    select: { id: true },
    take: PURGE_BATCH,
  });
  const oldEvents = await prisma.notificationSourceEvent.findMany({
    where: { firstSeenAt: { lt: before } },
    select: { source: true, eventId: true },
    take: PURGE_BATCH,
  });
  const deliveries = oldDeliveries.length
    ? await prisma.notificationDelivery.deleteMany({ where: { id: { in: oldDeliveries.map((d) => d.id) } } })
    : { count: 0 };
  const events = oldEvents.length
    ? await prisma.notificationSourceEvent.deleteMany({ where: { OR: oldEvents.map((e) => ({ source: e.source, eventId: e.eventId })) } })
    : { count: 0 };
  return { deliveries: deliveries.count, events: events.count };
}
