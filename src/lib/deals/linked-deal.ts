/**
 * 1つの物件に取引がいくつかあるとき、物件と連動させる取引(案件ステータス・契約日/決済予定日で共通)。
 * deals は新しい順(createdAt desc, id desc)。中止でない最初の取引、全部中止なら一番新しい取引。
 */
export function pickLinkedDeal<T extends { status: string }>(deals: readonly T[]): T | null {
  return deals.find((d) => d.status !== "cancelled") ?? deals[0] ?? null;
}

/** 連動させる取引を選ぶための並び(pickLinkedDeal に渡す deals の orderBy)。 */
export const LINKED_DEAL_ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];
