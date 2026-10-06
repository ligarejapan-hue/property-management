/**
 * 取込行の確定(作成・再試行)でつないだ棟へ、行の「棟郵便番号」を入れる。
 * CSV 取込(api/import/csv の applyBuildingPostalCode)と同じ決まり:
 * - 妥当な7桁(正規化済み)だけを渡す。空欄・不正値で既存の値を消さない。
 * - 今の値と違うときだけ書き、棟の変更履歴(source=csv_import)を残す。
 * ⚠物件を作るのと同じトランザクションの中で呼ぶ。
 */
import { recordChangesInTx, BUILDING_TRACKED_FIELDS } from "@/lib/change-log";
import type { Prisma } from "@/generated/prisma";

export async function applyBuildingPostalCodeInTx(
  tx: Prisma.TransactionClient,
  buildingId: string,
  normalizedPostalCode: string,
  changedBy: string,
): Promise<void> {
  const building = await tx.building.findUnique({
    where: { id: buildingId },
    select: { postalCode: true },
  });
  if (!building) return;
  const prev = building.postalCode ?? null;
  if (prev === normalizedPostalCode) return;

  await tx.building.update({
    where: { id: buildingId },
    data: { postalCode: normalizedPostalCode },
  });
  await recordChangesInTx(tx, {
    targetTable: "buildings",
    targetId: buildingId,
    changedBy,
    oldValues: { postalCode: prev },
    newValues: { postalCode: normalizedPostalCode },
    trackedFields: BUILDING_TRACKED_FIELDS,
    source: "csv_import",
  });
}
