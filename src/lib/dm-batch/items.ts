import type { BatchItemForCheck } from "./eligibility";

// 控え items の読取と集合比較(設計書§2.1/§2.2)。
// CSV ダウンロードと一括確定の両 tx が「先読み→ロック→再読取→不一致中止」の型で使う。

export interface BatchItemTxLike {
  dmExportBatchItem: {
    findMany: (args: unknown) => Promise<
      Array<{
        id: string;
        propertyId: string | null;
        ownerId: string | null;
        itemOwners: Array<{ ownerId: string }>;
      }>
    >;
  };
}

export async function readItemsWithOwners(
  tx: BatchItemTxLike,
  batchId: string,
): Promise<BatchItemForCheck[]> {
  const rows = await tx.dmExportBatchItem.findMany({
    where: { batchId },
    select: {
      id: true,
      propertyId: true,
      ownerId: true,
      itemOwners: { select: { ownerId: true } },
    },
    // 出力時の並び順(position)で読む(#364 R5: id は UUID で並び順を持たない)。
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    propertyId: r.propertyId,
    ownerId: r.ownerId,
    groupOwnerIds: r.itemOwners.map((o) => o.ownerId),
  }));
}

/** 先読みと再読取の集合一致判定に使う安定キー(id/参照/連関の順序非依存)。 */
export function itemSetKey(items: BatchItemForCheck[]): string {
  return JSON.stringify(
    items.map((it) => [
      it.id,
      it.propertyId,
      it.ownerId,
      [...it.groupOwnerIds].sort(),
    ]),
  );
}

/** items が参照する owner id(代表+連関)を平坦化する(ロック対象の列挙用)。 */
export function collectOwnerIds(items: BatchItemForCheck[]): string[] {
  return items.flatMap((it) => [
    ...(it.ownerId ? [it.ownerId] : []),
    ...it.groupOwnerIds,
  ]);
}

/** items が参照する物件 id(null 除外)。 */
export function collectPropertyIds(items: BatchItemForCheck[]): string[] {
  return items
    .map((it) => it.propertyId)
    .filter((v): v is string => v != null);
}
