/**
 * 通知 段階4b: 送信の記録を1通ずつ送る(設計書 §7.2・§7.4・§7.5)。
 *
 * 1通ごとに1つのトランザクションで:
 *  1. 端末の行を `FOR UPDATE SKIP LOCKED` で押さえる(押さえられなければその回は飛ばす=待たない)。
 *     付け替え・解除も同じ行を更新するので、送信が終わるまで待たされる(前の人宛てを次の人に送らない)。
 *  2. 送信記録の利用者・結び付けが端末の今と一致し、端末が無効化・期限切れでないことを確かめる。違えば取り消す。
 *  3. 記録を取り合う(`sending`・15分を過ぎた `sending` は取り直す)。取れなければ送らない。
 *  4. 含めた件を1件ずつ確かめ直し(完了・担当替え・期限・範囲・通知の設定)、残った件で本文を作り直す。
 *     0件なら送らずに取り消す。外した件の記録は消す(新しい期限・担当で改めて送れるように)。
 *  5. 送って、結果を「自分が取ったときの値」を条件に書く(取り直されたあとで上書きしない)。
 * トランザクションの時間制限(20秒)は送信の時間制限(10秒)より長い(テストで固定)。
 */
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { checkPushEndpoint } from "@/lib/push/endpoint";
import {
  canReceiveInquiryNotice,
  canReceiveRegistryNotice,
  dueNextActions,
  loadRecipient,
  nextActionCounts,
  registryJobVisibleCounts,
  visibleInquiryIds,
} from "./eligibility";
import { lockSubscription } from "./plan";
import { deriveNotificationKeys, seenKey } from "@/lib/notifications/opaque";
import {
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  RETRY_WINDOW_MS,
  SEND_BATCH_LIMIT,
  SEND_PRESEND_LIMIT_MS,
  SEND_RUN_BUDGET_MS,
  SEND_TX_MAX_WAIT_MS,
  SEND_TX_TIMEOUT_MS,
  inquiryPayload,
  nextActionPayload,
  parseEventRefKey,
  parseNextActionRefKey,
  registryJobPayload,
  type PushPayload,
} from "./rules";
import type { PushSender } from "./web-push-sender";

type Tx = Prisma.TransactionClient;

export type SendResult = "sent" | "failed" | "gone" | "cancelled" | "busy" | "skipped";

/**
 * 送ってよい状態の送信記録(初回・送り直し・15分を過ぎた送信中の残骸)。
 * 送信中の残骸の取り直しも送り直しと同じく「最大3回・作ってから2時間まで」(処理が落ち続けても
 * 何度も送らない・@codex #472 P2)。
 */
export function claimableWhere(now: Date): Prisma.NotificationDeliveryWhereInput {
  const retryable = { attempts: { lt: MAX_ATTEMPTS }, scheduledFor: { gt: new Date(now.getTime() - RETRY_WINDOW_MS) } };
  return {
    OR: [
      { status: "pending" },
      { status: "failed", ...retryable, claimedAt: { lt: new Date(now.getTime() - RETRY_BACKOFF_MS) } },
      { status: "sending", ...retryable, claimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
    ],
  };
}

/** 回数・期間を使い切った送信中の残骸は failed で締める(もう取り直さない)。 */
export async function closeAbandonedClaims(now: Date): Promise<number> {
  const r = await prisma.notificationDelivery.updateMany({
    where: {
      status: "sending",
      claimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) },
      OR: [{ attempts: { gte: MAX_ATTEMPTS } }, { scheduledFor: { lte: new Date(now.getTime() - RETRY_WINDOW_MS) } }],
    },
    data: { status: "failed", lastErrorCode: "abandoned" },
  });
  return r.count;
}

/** 送る前の処理が長引いた(送り始めると結果を書く時間が残らない)。送らずに巻き戻す。 */
class PreSendTooSlow extends Error {
  constructor() {
    super("presend_too_slow");
  }
}

export async function sendDueDeliveries(
  now: Date,
  sender: PushSender,
  opts: { startedAtMs?: number; budgetMs?: number } = {},
): Promise<Record<SendResult, number>> {
  const stats: Record<SendResult, number> = { sent: 0, failed: 0, gone: 0, cancelled: 0, busy: 0, skipped: 0 };
  const startedAtMs = opts.startedAtMs ?? Date.now();
  const budgetMs = opts.budgetMs ?? SEND_RUN_BUDGET_MS;
  await closeAbandonedClaims(now);
  const due = await prisma.notificationDelivery.findMany({
    where: claimableWhere(now),
    select: { id: true },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: SEND_BATCH_LIMIT,
  });
  for (const d of due) {
    // 持ち時間を過ぎたら新しい送信は始めない(残りは次の実行で・timer の起動と重ならないように)。
    if (Date.now() - startedAtMs >= budgetMs) break;
    let result: SendResult;
    try {
      result = await sendOne(d.id, now, sender);
    } catch (e) {
      if (e instanceof PreSendTooSlow) {
        stats.busy += 1;
        continue;
      }
      // 1通の DB の失敗で全体を止めない(記録は残り、次の実行で送る)。中身はログに出さない。
      result = "skipped";
    }
    stats[result] += 1;
  }
  return stats;
}

export function sendOne(
  deliveryId: string,
  now: Date,
  sender: PushSender,
  opts: { presendLimitMs?: number } = {},
): Promise<SendResult> {
  const presendLimitMs = opts.presendLimitMs ?? SEND_PRESEND_LIMIT_MS;
  return prisma.$transaction(async (tx) => {
    const txStartedMs = Date.now();
    const d = await tx.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, userId: true, subscriptionId: true, bindingId: true, kind: true, refs: { select: { id: true, refKey: true } } },
    });
    if (!d) return "skipped";
    const s = await lockSubscription(tx, d.subscriptionId);
    if (!s) return "busy";
    const claimable = { AND: [{ id: d.id }, claimableWhere(now)] };
    // 期限の確かめは、実行の始めの時刻ではなく今の時刻で(送信が続いて実行が長引いても遅れない)。
    const checkAt = new Date(Math.max(now.getTime(), Date.now()));

    // 結び付けが変わった・無効化・期限切れの端末には送らない(前の人宛てを次の人に送らない・§7.5)。
    if (s.userId !== d.userId || s.bindingId !== d.bindingId || s.revokedAt !== null || s.expiresAt <= checkAt) {
      const c = await tx.notificationDelivery.updateMany({ where: claimable, data: { status: "cancelled", lastErrorCode: "binding_changed" } });
      return c.count > 0 ? "cancelled" : "skipped";
    }
    // 許可リストを後から狭めた場合や、確認の導入前の行に備えて送信時にも確かめる(§7.2)。
    if (!checkPushEndpoint(s.endpoint).ok) {
      await tx.pushSubscription.update({ where: { id: s.id }, data: { revokedAt: now, revokedReason: "endpoint_not_allowed" } });
      const c = await tx.notificationDelivery.updateMany({ where: claimable, data: { status: "cancelled", lastErrorCode: "endpoint_not_allowed" } });
      return c.count > 0 ? "cancelled" : "skipped";
    }

    // 取り合い: 取れた処理だけが送る。取ったときの値を覚えて、結果の書き込みの条件にする。
    const claimedAt = checkAt;
    const claimed = await tx.notificationDelivery.updateMany({
      where: claimable,
      data: { status: "sending", claimedAt, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return "skipped";
    const mine = { id: d.id, status: "sending", claimedAt };

    // 確かめ直しも送る時刻で(実行が長引いて回の境目や日付をまたいでも、古い回・古い件数を送らない・@codex #472 P2)。
    const checked = await recheck(tx, d, s.bindingId, checkAt);
    if (checked.drop.length > 0) await tx.notificationDeliveryRef.deleteMany({ where: { id: { in: checked.drop } } });
    if (!checked.payload) {
      await tx.notificationDelivery.updateMany({ where: mine, data: { status: "cancelled", lastErrorCode: "nothing_to_send" } });
      return "cancelled";
    }

    // ここまでに時間を使いすぎていたら送らずに巻き戻す(取り合いも消える=次の実行でやり直す)。
    if (Date.now() - txStartedMs > presendLimitMs) throw new PreSendTooSlow();
    const outcome = await sender({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, checked.payload);
    if (outcome.ok) {
      await tx.notificationDelivery.updateMany({ where: mine, data: { status: "sent", sentAt: new Date(), lastErrorCode: null } });
      await tx.pushSubscription.update({ where: { id: s.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
      return "sent";
    }
    if (outcome.gone) {
      // 中継サービスが宛先は無効と返した(404/410)。登録を無効にし、同じ宛先での再有効化は断る(4a)。
      await tx.notificationDelivery.updateMany({ where: mine, data: { status: "gone", lastErrorCode: outcome.code } });
      await tx.pushSubscription.update({ where: { id: s.id }, data: { revokedAt: new Date(), revokedReason: "gone" } });
      return "gone";
    }
    await tx.notificationDelivery.updateMany({ where: mine, data: { status: "failed", lastErrorCode: outcome.code } });
    await tx.pushSubscription.update({ where: { id: s.id }, data: { failureCount: { increment: 1 } } });
    return "failed";
  }, { timeout: SEND_TX_TIMEOUT_MS, maxWait: SEND_TX_MAX_WAIT_MS });
}

interface Recheck {
  /** 外した件(記録を消す)。 */
  drop: string[];
  /** 残った件で作り直した本文。0件なら null。 */
  payload: PushPayload | null;
}

/** 含めた件を今の DB で1件ずつ確かめ直す(§7.4・§9)。 */
export async function recheck(
  tx: Tx,
  d: { userId: string; kind: string; refs: Array<{ id: string; refKey: string }> },
  bindingId: string,
  now: Date,
): Promise<Recheck> {
  const all = d.refs.map((r) => r.id);
  const r = await loadRecipient(tx, d.userId);
  if (!r) return { drop: all, payload: null };

  if (d.kind === "next_action") {
    const parsed = d.refs.map((ref) => ({ ref, key: parseNextActionRefKey(ref.refKey) }));
    const ids = [...new Set(parsed.flatMap((p) => (p.key ? [p.key.id] : [])))];
    const current = new Map((await dueNextActions(tx, r, now, ids)).map((x) => [x.id, x]));
    const keep: Array<{ dueTime?: string }> = [];
    const drop: string[] = [];
    for (const { ref, key } of parsed) {
      const cur = key ? current.get(key.id) : undefined;
      // 未完了・担当が本人・見える範囲(dueNextActions の条件)で、期限と版と回が記録のときと同じ。
      // 回が進んでいたら古い回の送り直しはやめる(新しい回の記録が別に作られる=2通にしない)。
      if (!key || !cur || Math.floor(cur.deadline / 1000) !== key.deadlineSec || cur.revMs !== key.revMs || cur.slot !== key.slot) {
        drop.push(ref.id);
        continue;
      }
      keep.push(cur.dueTime ? { dueTime: cur.dueTime } : {});
    }
    if (keep.length === 0) return { drop, payload: null };
    const counts = await nextActionCounts(tx, r, now);
    return { drop, payload: nextActionPayload(bindingId, keep, counts.today, counts.overdue) };
  }

  if (d.kind === "inquiry_new") {
    // 送る直前にも在籍・通知 ON・申込一覧の権限を確かめ直す(メール通知と同じ・§9)。
    if (!(await canReceiveInquiryNotice(r))) return { drop: all, payload: null };
    const parsed = d.refs.map((ref) => ({ ref, id: parseEventRefKey("inquiry", ref.refKey) }));
    const visible = await visibleInquiryIds(tx, r, parsed.flatMap((p) => (p.id ? [p.id] : [])));
    const drop = parsed.filter((p) => !p.id || !visible.has(p.id)).map((p) => p.ref.id);
    const keep = parsed.length - drop.length;
    return { drop, payload: keep > 0 ? inquiryPayload(bindingId, keep) : null };
  }

  if (d.kind === "registry_job_done") {
    if (!canReceiveRegistryNotice(r) || d.refs.length !== 1) return { drop: all, payload: null };
    const jobId = parseEventRefKey("registry_job", d.refs[0].refKey);
    const counts = jobId ? await registryJobVisibleCounts(tx, r, jobId) : null;
    if (!jobId || !counts) return { drop: all, payload: null };
    const tagKey = seenKey(deriveNotificationKeys(), r.id, "registry_job", [jobId]);
    return { drop: [], payload: registryJobPayload(bindingId, jobId, tagKey, counts) };
  }
  return { drop: all, payload: null };
}
