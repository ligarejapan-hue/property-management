/**
 * 共用 PC の後片付けの「切り替えの世代」(設計書 §4.5)。**純関数だけ**。
 *
 * - Service Worker(`public/sw.js`)と画面側(`sw-client.ts` の直接の後片付け)が
 *   同じ IndexedDB の1行を、同じ規則で書き換える。⚠規則を変えるときは sw.js も揃える
 *   (`sw-js-source.test.ts` で定数と要の分岐を固定)。
 * - 後片付けの依頼ごとに乱数 `cleanupId` を付け、**処理済みの一覧に同じ id があれば何もしない**
 *   (遅れて届いた同じ依頼が、新しい人の画面・通知を止めないため)。
 * - 一覧は直近の複数件を残す(最後の1つだけだと、A→B→遅れてA の順で取り違えるため)。
 */

export interface CleanupState {
  gen: number;
  cleanupIds: { id: string; at: number }[];
}

export const CLEANUP_IDS_MAX = 100;
export const CLEANUP_IDS_TTL_MS = 24 * 60 * 60 * 1000;

export function emptyCleanupState(): CleanupState {
  return { gen: 0, cleanupIds: [] };
}

export function normalizeCleanupState(v: unknown): CleanupState {
  if (!v || typeof v !== "object") return emptyCleanupState();
  const o = v as Record<string, unknown>;
  const gen = typeof o.gen === "number" && Number.isFinite(o.gen) ? o.gen : 0;
  const ids = Array.isArray(o.cleanupIds)
    ? o.cleanupIds.filter(
        (x): x is { id: string; at: number } =>
          !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && typeof (x as { at?: unknown }).at === "number",
      )
    : [];
  return { gen, cleanupIds: ids };
}

export function applyCleanup(
  state: CleanupState,
  cleanupId: string,
  now: number,
): { state: CleanupState; changed: boolean } {
  if (state.cleanupIds.some((x) => x.id === cleanupId)) {
    return { state, changed: false };
  }
  const kept = state.cleanupIds.filter((x) => now - x.at < CLEANUP_IDS_TTL_MS);
  const cleanupIds = [...kept, { id: cleanupId, at: now }].slice(-CLEANUP_IDS_MAX);
  return { state: { gen: state.gen + 1, cleanupIds }, changed: true };
}
