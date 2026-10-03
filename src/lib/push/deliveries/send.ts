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
  type Recipient,
} from "./eligibility";
import { lockSubscription } from "./plan";
import { assertCanLockOwner, assertCanLockProperty } from "@/lib/edit-lock/permissions";
import { EDIT_LOCK_HEARTBEAT_GRACE_MS, EDIT_LOCK_IDLE_LIMIT_MS } from "@/lib/edit-lock/rules";
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
  EDIT_LOCK_LOSS_NOTIFY_WINDOW_MS,
  editLockLostPayload,
  inquiryPayload,
  nextActionPayload,
  parseEditLockLossRefKey,
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

/** 回数・期間を使い切った送信中の残骸は failed で締める(もう取り直さない)。1回に1,000件まで。 */
export async function closeAbandonedClaims(now: Date): Promise<number> {
  const ids = await prisma.notificationDelivery.findMany({
    where: {
      status: "sending",
      claimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) },
      OR: [{ attempts: { gte: MAX_ATTEMPTS } }, { scheduledFor: { lte: new Date(now.getTime() - RETRY_WINDOW_MS) } }],
    },
    select: { id: true },
    take: 1000,
  });
  if (ids.length === 0) return 0;
  const r = await prisma.notificationDelivery.updateMany({
    where: { id: { in: ids.map((x) => x.id) }, status: "sending" },
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
  // 持ち時間を過ぎていたら片付けも送信も始めない(@codex #472 P2)。
  if (Date.now() - startedAtMs >= budgetMs) return stats;
  await closeAbandonedClaims(now);
  // 1時間で送れなくなる編集権限の知らせを先に送る(ほかの溜まった分の後ろで時間切れにならない・@codex #473 P2)。
  const urgent = await prisma.notificationDelivery.findMany({
    where: { AND: [claimableWhere(now), { kind: "edit_lock_lost" }] },
    select: { id: true },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: SEND_BATCH_LIMIT,
  });
  const rest = await prisma.notificationDelivery.findMany({
    where: { AND: [claimableWhere(now), { kind: { not: "edit_lock_lost" } }] },
    select: { id: true },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: Math.max(0, SEND_BATCH_LIMIT - urgent.length),
  });
  const due = [...urgent, ...rest];
  for (const d of due) {
    // 持ち時間を過ぎたら新しい送信は始めない(残りは次の実行で・timer の起動と重ならないように)。
    if (Date.now() - startedAtMs >= budgetMs) break;
    let result: SendResult;
    try {
      result = await sendOne(d.id, now, sender);
    } catch {
      // 1通の DB の失敗で全体を止めない(記録は残り、次の実行で送る)。中身はログに出さない。
      result = "skipped";
    }
    stats[result] += 1;
  }
  return stats;
}

/**
 * 1通を送る。2つのトランザクションに分ける(@codex #472 P2):
 *  1. 取り合い(sending・回数+1)を**先に確定**させる。送ったあとに処理が落ちても、取り合いと回数が
 *     巻き戻らない(=15分の残骸扱い・最大3回が効く。すぐにもう一度送らない)。
 *  2. 端末の行を SKIP LOCKED で押さえ、利用者・結び付け・期限を**もう一度**確かめてから送る
 *     (1 と 2 の間に付け替えが起きても前の人宛てを送らない)。送信は行を押さえたまま行う。
 * 2 で端末を押さえられなかった・送る前が長引いたときは送っていないので、取り合いを戻す
 * (failed・回数を戻す=10分あけて次の実行で)。
 */
export async function sendOne(
  deliveryId: string,
  now: Date,
  sender: PushSender,
  opts: { presendLimitMs?: number } = {},
): Promise<SendResult> {
  const presendLimitMs = opts.presendLimitMs ?? SEND_PRESEND_LIMIT_MS;
  // 期限の確かめは、実行の始めの時刻ではなく今の時刻で(送信が続いて実行が長引いても遅れない)。
  const checkAt = new Date(Math.max(now.getTime(), Date.now()));

  // ---- 1. 取り合いを確定させる ----
  const claim = await prisma.$transaction(async (tx) => {
    const d = await tx.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, userId: true, subscriptionId: true, bindingId: true, status: true, claimedAt: true },
    });
    if (!d) return { result: "skipped" as const };
    const s = await tx.pushSubscription.findUnique({ where: { id: d.subscriptionId } });
    const claimable = { AND: [{ id: d.id }, claimableWhere(now)] };
    // 結び付けが変わった・無効化・期限切れの端末には送らない(前の人宛てを次の人に送らない・§7.5)。
    if (!s || s.userId !== d.userId || s.bindingId !== d.bindingId || s.revokedAt !== null || s.expiresAt <= checkAt) {
      const c = await tx.notificationDelivery.updateMany({ where: claimable, data: { status: "cancelled", lastErrorCode: "binding_changed" } });
      return { result: c.count > 0 ? ("cancelled" as const) : ("skipped" as const) };
    }
    // 許可リストを後から狭めた場合や、確認の導入前の行に備えて送信時にも確かめる(§7.2)。
    if (!checkPushEndpoint(s.endpoint).ok) {
      await tx.pushSubscription.update({ where: { id: s.id }, data: { revokedAt: now, revokedReason: "endpoint_not_allowed" } });
      const c = await tx.notificationDelivery.updateMany({ where: claimable, data: { status: "cancelled", lastErrorCode: "endpoint_not_allowed" } });
      return { result: c.count > 0 ? ("cancelled" as const) : ("skipped" as const) };
    }
    // 取り合い: 取れた処理だけが送る。取ったときの値を覚えて、結果の書き込みの条件にする。
    // 読んだときの状態のままのときだけ取る(戻すときに元の状態へ正しく戻せるように)。
    const claimed = await tx.notificationDelivery.updateMany({
      where: { AND: [claimable, { status: d.status, claimedAt: d.claimedAt }] },
      data: { status: "sending", claimedAt: checkAt, attempts: { increment: 1 } },
    });
    return claimed.count === 0
      ? { result: "skipped" as const }
      : { result: "claimed" as const, prev: { status: d.status, claimedAt: d.claimedAt } };
  }, { timeout: SEND_TX_TIMEOUT_MS, maxWait: SEND_TX_MAX_WAIT_MS });
  if (claim.result !== "claimed") return claim.result;
  const mine = { id: deliveryId, status: "sending", claimedAt: checkAt };

  // 送っていない(端末を押さえられない・送る前が長引いた)ときは取り合いを元の状態に戻す(回数も戻す)。
  const prev = claim.prev;
  const releaseClaim = () =>
    prisma.notificationDelivery.updateMany({ where: mine, data: { status: prev.status, claimedAt: prev.claimedAt, attempts: { decrement: 1 } } });

  // ---- 2. 端末を押さえて、確かめ直してから送る ----
  let result: SendResult | "busy_release" | "slow_release";
  try {
    result = await prisma.$transaction(async (tx) => {
      const txStartedMs = Date.now();
      const d = await tx.notificationDelivery.findUnique({
        where: { id: deliveryId },
        select: { id: true, userId: true, subscriptionId: true, bindingId: true, kind: true, status: true, claimedAt: true, refs: { select: { id: true, refKey: true } } },
      });
      // 取り直された(自分の取り合いでなくなった)なら何もしない。
      if (!d || d.status !== "sending" || d.claimedAt?.getTime() !== checkAt.getTime()) return "skipped" as const;
      const s = await lockSubscription(tx, d.subscriptionId);
      if (!s) return "busy_release" as const;
      const at = new Date(Math.max(checkAt.getTime(), Date.now()));
      if (s.userId !== d.userId || s.bindingId !== d.bindingId || s.revokedAt !== null || s.expiresAt <= at || !checkPushEndpoint(s.endpoint).ok) {
        await tx.notificationDelivery.updateMany({ where: mine, data: { status: "cancelled", lastErrorCode: "binding_changed" } });
        return "cancelled" as const;
      }
      // 確かめ直しも送る時刻で(実行が長引いて回の境目や日付をまたいでも、古い回・古い件数を送らない)。
      const checked = await recheck(tx, d, s.bindingId, at);
      if (checked.drop.length > 0) await tx.notificationDeliveryRef.deleteMany({ where: { id: { in: checked.drop } } });
      if (!checked.payload) {
        await tx.notificationDelivery.updateMany({ where: mine, data: { status: "cancelled", lastErrorCode: "nothing_to_send" } });
        return "cancelled" as const;
      }
      // ここまでに時間を使いすぎていたら送らずに巻き戻す(結果を書く時間を残す)。
      if (Date.now() - txStartedMs > presendLimitMs) throw new PreSendTooSlow();
      const outcome = await sender({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, checked.payload);
      if (outcome.ok) {
        await tx.notificationDelivery.updateMany({ where: mine, data: { status: "sent", sentAt: new Date(), lastErrorCode: null } });
        await tx.pushSubscription.update({ where: { id: s.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
        return "sent" as const;
      }
      if (outcome.gone) {
        // 中継サービスが宛先は無効と返した(404/410)。登録を無効にし、同じ宛先での再有効化は断る(4a)。
        await tx.notificationDelivery.updateMany({ where: mine, data: { status: "gone", lastErrorCode: outcome.code } });
        await tx.pushSubscription.update({ where: { id: s.id }, data: { revokedAt: new Date(), revokedReason: "gone" } });
        return "gone" as const;
      }
      await tx.notificationDelivery.updateMany({ where: mine, data: { status: "failed", lastErrorCode: outcome.code } });
      await tx.pushSubscription.update({ where: { id: s.id }, data: { failureCount: { increment: 1 } } });
      return "failed" as const;
    }, { timeout: SEND_TX_TIMEOUT_MS, maxWait: SEND_TX_MAX_WAIT_MS });
  } catch (e) {
    if (e instanceof PreSendTooSlow) result = "slow_release";
    // それ以外(DB の失敗など)は送ったかどうか分からないので、取り合いは残す(15分の残骸扱い・回数は数えたまま)。
    else throw e;
  }
  if (result === "busy_release") {
    await releaseClaim();
    return "busy";
  }
  if (result === "slow_release") {
    await releaseClaim();
    return "busy";
  }
  return result;
}

/** 鍵を取る窓口(`/api/edit-locks/acquire`)と同じ条件で、今その資源を編集できるか。 */
async function canStillEdit(tx: Tx, r: Recipient, resourceType: "property" | "owner", resourceId: string): Promise<boolean> {
  try {
    if (resourceType === "property") {
      const p = await tx.property.findUnique({ where: { id: resourceId }, select: { createdBy: true, assignedTo: true, isArchived: true } });
      if (!p || p.isArchived) return false;
      assertCanLockProperty(r, r.permissions, p);
      return true;
    }
    const o = await tx.owner.findUnique({ where: { id: resourceId }, select: { isArchived: true } });
    if (!o || o.isArchived) return false;
    assertCanLockOwner(r.permissions);
    return true;
  } catch (e) {
    // 権限の判定で「できない」と決まったときだけ false。それ以外(DB の失敗など)は投げてやり直させる。
    if ((e as { status?: unknown } | null)?.status === 403) return false;
    throw e;
  }
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
  if (d.kind === "edit_lock_lost") {
    // 外れた持ち主本人の記録で、外れてから1時間以内のものだけ(在籍の確認は上の loadRecipient)。
    const eventId = d.refs.length === 1 ? parseEditLockLossRefKey(d.refs[0].refKey) : null;
    const e = eventId ? await tx.editLockLossEvent.findUnique({ where: { id: eventId } }) : null;
    if (!e || e.userId !== r.id || e.occurredAt.getTime() < now.getTime() - EDIT_LOCK_LOSS_NOTIFY_WINDOW_MS) {
      return { drop: all, payload: null };
    }
    if (e.cause !== "heartbeat" && e.cause !== "idle" && e.cause !== "force_released") return { drop: all, payload: null };
    // 今もその資源を編集できる人か(鍵を取る窓口と同じ判定・@codex #473 P2)。権限が外れた・担当から外れた・
    // アーカイブされた資源について、その画面へのリンク付きの知らせを送らない。
    if (!(await canStillEdit(tx, r, e.resourceType, e.resourceId))) return { drop: all, payload: null };
    // 本人がすでに同じ記録の鍵を取り直して編集を続けている(期限内の鍵を持っている)なら送らない
    // (同じ画面の取り直しは知らせない、と同じ考え方・@codex #473 P2)。
    const back = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "edit_locks"
      WHERE "resource_type" = ${e.resourceType}::"EditLockResource" AND "resource_id" = ${e.resourceId}::uuid
        AND "user_id" = ${r.id}::uuid AND "id" <> ${e.lockId}::uuid AND "force_released_at" IS NULL
        AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${EDIT_LOCK_HEARTBEAT_GRACE_MS / 1000}::double precision)
        AND "activity_at" >= clock_timestamp() - make_interval(secs => ${EDIT_LOCK_IDLE_LIMIT_MS / 1000}::double precision)`;
    if (back.length > 0) return { drop: all, payload: null };
    return { drop: [], payload: editLockLostPayload(bindingId, { resourceType: e.resourceType, resourceId: e.resourceId, cause: e.cause }) };
  }
  return { drop: all, payload: null };
}
