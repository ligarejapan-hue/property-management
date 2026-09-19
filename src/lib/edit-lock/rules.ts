/**
 * 編集中の鍵の判定ルール(純関数)。DB にも画面にも依存させない。
 * SQL 側(service.ts)とこのファイルは同じ定数から条件を組み立てる。
 */
// ⚠"use client" の idle-session-guard.tsx(react・next-auth/react を引き込む)を経由しない。
// service.ts 経由でサーバ側 route handler(Task 5-6)にバンドルされるため、依存の無い
// プレーンなモジュールから読む(idle-session-guard.tsx は同じ値を re-export している)。
import { IDLE_TIMEOUT_MS } from "@/lib/idle-timeout";

export const EDIT_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
export const EDIT_LOCK_HEARTBEAT_GRACE_MS = 5 * 60_000;
/** 無操作の上限。自動ログアウトと同じ(テストで一致を固定)。 */
export const EDIT_LOCK_IDLE_LIMIT_MS = IDLE_TIMEOUT_MS;
export const EDIT_LOCK_IDLE_WARN_MS = 55 * 60_000;
export const EDIT_LOCK_STATUS_POLL_MS = 30_000;

export type EditLockResourceType = "property" | "owner";

export type EditLockRow = {
  id: string;
  userId: string;
  screenTokenHash: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  activityAt: Date;
  forceReleasedAt: Date | null;
};

export type EditLockRequester = { userId: string; screenTokenHash: string };

export type EditLockState =
  | { state: "free" }
  | { state: "mine"; lockId: string; since: Date }
  | { state: "held_by_self_other_screen"; lockId: string; since: Date }
  | { state: "held_by_other"; lockId: string; holderUserId: string; since: Date }
  | { state: "force_released_mine"; lockId: string };

export function isLockExpired(lock: EditLockRow, now: Date): boolean {
  return expiryCause(lock, now) !== null;
}

/**
 * 何が原因で期限切れになったか。監査に残す。
 * ⚠合図と操作は**上限が違う**(5分と60分)ので、古さの大小で決めてはいけない。
 * 両方超えているときは、先に効く合図の側を原因とする。
 * ⚠この関数は service.ts の SQL の条件と一致することをテストで固定するための基準でもある。
 */
export function expiryCause(lock: EditLockRow, now: Date): "heartbeat" | "idle" | null {
  const t = now.getTime();
  if (t - lock.heartbeatAt.getTime() > EDIT_LOCK_HEARTBEAT_GRACE_MS) return "heartbeat";
  if (t - lock.activityAt.getTime() > EDIT_LOCK_IDLE_LIMIT_MS) return "idle";
  return null;
}

export function evaluateLock(
  lock: EditLockRow | null,
  now: Date,
  requester: EditLockRequester,
): EditLockState {
  if (!lock) return { state: "free" };
  const sameHolder =
    lock.userId === requester.userId &&
    lock.screenTokenHash === requester.screenTokenHash;
  // 管理者に外された鍵は、外された本人にだけ「外された」と伝える(遅れて届く保存を断るため)。
  // 他の人から見れば空き。
  if (lock.forceReleasedAt) {
    return sameHolder
      ? { state: "force_released_mine", lockId: lock.id }
      : { state: "free" };
  }
  if (isLockExpired(lock, now)) return { state: "free" };
  if (sameHolder) return { state: "mine", lockId: lock.id, since: lock.acquiredAt };
  if (lock.userId === requester.userId) {
    return { state: "held_by_self_other_screen", lockId: lock.id, since: lock.acquiredAt };
  }
  return {
    state: "held_by_other",
    lockId: lock.id,
    holderUserId: lock.userId,
    since: lock.acquiredAt,
  };
}
