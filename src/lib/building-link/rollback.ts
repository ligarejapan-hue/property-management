/**
 * 取込の取り消しで、その取込が自動で作った棟のうち空になったものを消す(@codex P1・2026-10-05)。
 * 残すと中身の無い棟が、後の自動づけ(同じ町丁目・同じ比べる形)を引き寄せる。
 *
 * 目印: 監査ログ `building.auto_create` の detail.importJobId。migration を足さずに棟と取込を結ぶ。
 *   ⚠取込の経路(CSV・要確認の確定・再試行)では applyBuildingLink が**棟を作ったのと同じ tx** で書く
 *   (@codex P2・2026-10-05)。握りつぶし型の writeAuditLog(tx の後)には頼らないので、棟があれば
 *   目印も必ずある(書けなければ棟ごと巻き戻る)。この修正より前の取込は tx の後に書いた行で、同じ形で読める。
 *
 * ⚠必ず**物件を消したのと同じトランザクション**で、物件を消した**後**に呼ぶ。
 * ⚠棟の行は FOR UPDATE **SKIP LOCKED**(id 昇順)。誰かがその棟を使っている最中(部屋を
 *   つなぐ保存=外部キーの確認で棟の行に共有ロック/棟の名前の反映/写真の追加)なら待たずに
 *   残す。取り消しは物件の行を先に押さえているので、ここで待つと、部屋の行(id順 FOR UPDATE)→
 *   棟の行(FOR NO KEY UPDATE)の順で動く棟の名前の反映・販売図面の書き戻しと待ち合う余地が出る。ロックを取れた棟は、数え終わるまで新しい部屋も
 *   写真もつながらない(つなぐ側の外部キーの確認がこのロックを待つ)。
 */
import { sortUniqueIds } from "@/lib/dm-batch/locks";

export type RollbackBuildingTx = {
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  building: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; _count: { select: { properties: true; photos: true } } };
    }) => Promise<{ id: string; _count: { properties: number; photos: number } }[]>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
  };
};

export type KeptBuildingReason = "has_properties" | "has_photos" | "in_use";

export interface BuildingCleanupResult {
  deletedBuildingIds: string[];
  /** 残した棟と理由(id と理由だけ。住所・名前は入れない)。 */
  keptBuildings: { buildingId: string; reason: KeptBuildingReason }[];
}

type AuditLogReader = {
  auditLog: {
    findMany: (args: {
      where: { action: string; targetTable: string; detail: { path: string[]; equals: string } };
      select: { targetId: true };
    }) => Promise<{ targetId: string | null }[]>;
  };
};

/** この取込が自動で作った棟の id(小文字・重複なし・昇順)。 */
export async function findImportAutoCreatedBuildingIds(db: AuditLogReader, jobId: string): Promise<string[]> {
  const logs = await db.auditLog.findMany({
    where: { action: "building.auto_create", targetTable: "buildings", detail: { path: ["importJobId"], equals: jobId } },
    select: { targetId: true },
  });
  return sortUniqueIds(logs.flatMap((l) => (l.targetId ? [l.targetId.toLowerCase()] : [])));
}

/** 候補の棟のうち、ロックを取れて部屋も写真も 0 のものだけ消す。もう無い棟は黙って飛ばす。 */
export async function removeEmptyAutoCreatedBuildings(
  tx: RollbackBuildingTx,
  buildingIds: string[],
): Promise<BuildingCleanupResult> {
  const ids = sortUniqueIds(buildingIds.map((id) => id.toLowerCase()));
  const result: BuildingCleanupResult = { deletedBuildingIds: [], keptBuildings: [] };
  if (ids.length === 0) return result;

  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM buildings WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE SKIP LOCKED`;
  const lockedIds = new Set(locked.map((r) => r.id.toLowerCase()));
  // ⚠数えるのはロックの後(READ COMMITTED: この文はロックまでに commit された部屋・写真を見る)。
  const rows = await tx.building.findMany({
    where: { id: { in: ids } },
    select: { id: true, _count: { select: { properties: true, photos: true } } },
  });
  const deletable: string[] = [];
  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const id = row.id.toLowerCase();
    if (!lockedIds.has(id)) result.keptBuildings.push({ buildingId: id, reason: "in_use" });
    else if (row._count.properties > 0) result.keptBuildings.push({ buildingId: id, reason: "has_properties" });
    else if (row._count.photos > 0) result.keptBuildings.push({ buildingId: id, reason: "has_photos" });
    else deletable.push(id);
  }
  if (deletable.length > 0) {
    await tx.building.deleteMany({ where: { id: { in: deletable } } });
    result.deletedBuildingIds = deletable;
  }
  return result;
}
