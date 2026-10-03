/**
 * Web プッシュの登録先(端末)の保存・延長・解除(通知 段階4a・設計書 §7.2・§7.5)。サーバー専用。
 *
 * - endpoint は承認済みの中継サービスだけ(`endpoint.ts`)。拒否の理由は定型コードだけで返す。
 * - 付け替えの判断は純関数 `decideBinding`。1つの端末(endpoint)を同時に2人が登録しても
 *   順に処理されるよう、行を FOR UPDATE で押さえてから判断する。
 * - ⚠endpoint・鍵は戻り値・ログ・監査ログに出さない。戻すのは結び付け(binding_id)と範囲・期限だけ。
 */
import { randomUUID } from "crypto";
import { ApiError } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { checkPushEndpoint } from "./endpoint";
import { SHARED_TTL_MS, decideBinding, type DeviceScope, type ExistingSubscription } from "./binding";

/** 鍵は base64url(p256dh は公開鍵 65バイト=87文字・auth は 16バイト=22文字。余裕を見て上限を置く)。 */
const KEY_RE = /^[A-Za-z0-9_-]{16,200}$/;

export interface SubscriptionInput {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
  /** 今の利用者がこの操作で選んだ範囲。ログイン後の自動の付け替えでは渡さない。 */
  deviceScope?: DeviceScope;
}

export interface SubscriptionResult {
  bindingId: string;
  deviceScope: DeviceScope;
  expiresAt: Date;
  /** 新しい結び付けになったか(画面は binding_id を保存し直す)。 */
  rebound: boolean;
}

function assertKeys(p256dh: unknown, auth: unknown): asserts p256dh is string {
  if (typeof p256dh !== "string" || !KEY_RE.test(p256dh) || typeof auth !== "string" || !KEY_RE.test(auth)) {
    throw new ApiError(422, "通知の登録情報が正しくありません", "subscription_invalid");
  }
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";
}

/** 登録・付け替え。 */
export async function upsertPushSubscription(userId: string, input: SubscriptionInput, now = new Date()): Promise<SubscriptionResult> {
  const check = checkPushEndpoint(input.endpoint);
  if (!check.ok) throw new ApiError(422, "このブラウザの通知の送り先は使えません", check.code);
  assertKeys(input.p256dh, input.auth);
  const endpoint = input.endpoint as string;
  const p256dh = input.p256dh as string;
  const auth = input.auth as string;

  // 同じ端末を2つのタブ(や2人)が同時に初めて登録すると、片方が一意制約に当たる。1回だけやり直す。
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            user_id: string;
            device_scope: string;
            binding_id: string;
            bound_at: Date;
            expires_at: Date;
            revoked_at: Date | null;
            revoked_reason: string | null;
          }>
        >`
          SELECT "user_id", "device_scope", "binding_id", "bound_at", "expires_at", "revoked_at", "revoked_reason"
          FROM "push_subscriptions" WHERE "endpoint" = ${endpoint} FOR UPDATE
        `;
        const row = rows[0];
        const existing: ExistingSubscription | null = row
          ? {
              userId: row.user_id,
              deviceScope: row.device_scope,
              bindingId: row.binding_id,
              boundAt: row.bound_at,
              expiresAt: row.expires_at,
              revokedAt: row.revoked_at,
              revokedReason: row.revoked_reason,
            }
          : null;
        const d = decideBinding({ existing, userId, requestedScope: input.deviceScope, now, newBindingId: randomUUID() });
        if (d.kind === "gone") {
          // 中継サービスが無効と返した宛先は有効に戻さない。画面は購読を作り直して登録し直す。
          throw new ApiError(409, "この通知の登録は使えなくなりました", "endpoint_gone");
        }
        const data = {
          userId,
          p256dh,
          auth,
          deviceScope: d.deviceScope,
          bindingId: d.bindingId,
          boundAt: d.boundAt,
          expiresAt: d.expiresAt,
          revokedAt: null,
          revokedReason: null,
        };
        if (d.kind === "create") {
          await tx.pushSubscription.create({ data: { ...data, endpoint } });
        } else {
          // 4b: d.cancelPrevious のとき、ここで前の結び付けの送り待ちを取り消す(設計書 §7.5)。
          await tx.pushSubscription.update({ where: { endpoint }, data });
        }
        return { bindingId: d.bindingId, deviceScope: d.deviceScope, expiresAt: d.expiresAt, rebound: d.kind !== "keep" };
      });
    } catch (e) {
      if (attempt === 0 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

/**
 * shared の端末の期限を「今＋65分」に延ばす(自動ログオフの延長と同じ5分ごと・設計書 §7.5 の 1)。
 * 自分の・有効な・shared の登録だけ。延ばせなかった(期限切れ・無効化・別の利用者)ときは false
 * (画面は登録し直す=新しい結び付けになる)。personal は最後のログインから30日のまま。
 */
export async function extendPushSubscription(userId: string, endpoint: unknown, now = new Date()): Promise<boolean> {
  if (!checkPushEndpoint(endpoint).ok) return false;
  const res = await prisma.pushSubscription.updateMany({
    where: { endpoint: endpoint as string, userId, revokedAt: null, expiresAt: { gt: now }, deviceScope: "shared" },
    data: { expiresAt: new Date(now.getTime() + SHARED_TTL_MS) },
  });
  if (res.count > 0) return true;
  // personal で有効なら延ばす必要はない(true)。
  const personal = await prisma.pushSubscription.count({
    where: { endpoint: endpoint as string, userId, revokedAt: null, expiresAt: { gt: now }, deviceScope: "personal" },
  });
  return personal > 0;
}

export type RevokeReason = "logout" | "cancelled" | "key_changed";
export const REVOKE_REASONS: readonly RevokeReason[] = ["logout", "cancelled", "key_changed"];

/**
 * 解除(自分の登録だけ)。`bindingId` を渡したときは、その結び付けのままのときだけ無効にする
 * (登録の途中で後片付けが起きたときの取り消し用。あとから別の利用者・別の操作が付け替えていれば
 * 何もしない=次の人の登録を消さない)。
 */
export async function revokePushSubscription(
  userId: string,
  endpoint: unknown,
  now = new Date(),
  opts: { bindingId?: string; reason?: RevokeReason } = {},
): Promise<boolean> {
  if (!checkPushEndpoint(endpoint).ok) return false;
  const res = await prisma.pushSubscription.updateMany({
    where: { endpoint: endpoint as string, userId, revokedAt: null, ...(opts.bindingId ? { bindingId: opts.bindingId } : {}) },
    data: { revokedAt: now, revokedReason: opts.reason ?? "logout" },
  });
  return res.count > 0;
}

/** VAPID の公開鍵。3つそろっていなければ null(プッシュは使えない=画面内のお知らせだけ)。 */
export function vapidPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!pub || !priv || !subject) return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(pub)) return null;
  return pub;
}
