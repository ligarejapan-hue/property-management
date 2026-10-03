/**
 * 通知 段階4b・4c: 定期実行の1回分(設計書 §7.3)。systemd timer から数分ごとに呼ばれる。
 * 記録を作る(査定申込・謄本ジョブ・次回対応・編集権限が外れた)→ 送る → 古い記録を消す、の順。
 * 戻り値は件数だけ(中身・宛先は出さない)。
 */
import prisma from "@/lib/prisma";
import { planEditLockLossDeliveries, planNextActionDeliveries, planSourceDeliveries } from "./plan";
import { sendDueDeliveries, type SendResult } from "./send";
import { RECORD_RETENTION_MS, SEND_RUN_BUDGET_MS, SOURCES } from "./rules";
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
  // 申込・謄本ジョブはカーソルの行が無ければ(migration 前)例外=送らずに失敗で終わる(§7.6)。
  // 持ち時間を過ぎて飛ばしてもカーソルは進まないので、次の実行で同じ所から読む(取りこぼさない)。
  const [inquiry, registryJob] = await (async () => {
    const out: number[] = [];
    for (const s of SOURCES) out.push(pastDeadline() ? 0 : await planSourceDeliveries(s, now));
    return out;
  })();
  const nextAction = pastDeadline() ? 0 : await planNextActionDeliveries(now, { deadlineMs });
  // 飛ばした記録は pending のまま残るので、次の実行で分ける。
  const editLockLost = pastDeadline() ? 0 : await planEditLockLossDeliveries(now);
  const sent = await sendDueDeliveries(now, sender, { startedAtMs });
  const before = new Date(now.getTime() - RECORD_RETENTION_MS);
  const [deliveries, events, editLockLosses] = await Promise.all([
    prisma.notificationDelivery.deleteMany({
      where: { createdAt: { lt: before }, status: { in: ["sent", "failed", "gone", "cancelled"] } },
    }),
    prisma.notificationSourceEvent.deleteMany({ where: { firstSeenAt: { lt: before } } }),
    // 知らせ終わった外れた記録は30日で消す(設計書 §7.2)。
    prisma.editLockLossEvent.deleteMany({ where: { createdAt: { lt: before }, status: { in: ["queued", "expired"] } } }),
  ]);
  return {
    planned: { nextAction, inquiry, registryJob, editLockLost },
    sent,
    purged: { deliveries: deliveries.count, events: events.count, editLockLosses: editLockLosses.count },
  };
}
