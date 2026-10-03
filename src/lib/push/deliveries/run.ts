/**
 * 通知 段階4b: 定期実行の1回分(設計書 §7.3)。systemd timer から数分ごとに呼ばれる。
 * 記録を作る(次回対応・査定申込・謄本ジョブ)→ 送る → 古い記録を消す、の順。
 * 戻り値は件数だけ(中身・宛先は出さない)。
 */
import prisma from "@/lib/prisma";
import { planEditLockLossDeliveries, planNextActionDeliveries, planSourceDeliveries } from "./plan";
import { sendDueDeliveries, type SendResult } from "./send";
import { RECORD_RETENTION_MS, SOURCES } from "./rules";
import type { PushSender } from "./web-push-sender";

export interface PushRunResult {
  planned: { nextAction: number; inquiry: number; registryJob: number; editLockLost: number };
  sent: Record<SendResult, number>;
  purged: { deliveries: number; events: number; editLockLosses: number };
}

export async function runPushNotifications(now: Date, sender: PushSender): Promise<PushRunResult> {
  const startedAtMs = Date.now();
  // 申込・謄本ジョブはカーソルの行が無ければ(migration 前)例外=送らずに失敗で終わる(§7.6)。
  const [inquiry, registryJob] = await (async () => {
    const out: number[] = [];
    for (const s of SOURCES) out.push(await planSourceDeliveries(s, now));
    return out;
  })();
  const nextAction = await planNextActionDeliveries(now);
  const editLockLost = await planEditLockLossDeliveries(now);
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
