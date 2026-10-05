/**
 * CSV 取込の棟の解決(設計 2026-10-04 §4.4)。CSV は人が候補を選べないので、
 * 同じ町丁目・同じ比べる形だけを自動でつなぎ、紛らわしい候補があれば要確認に回す。
 * 実際の作成・つなぎは物件を作るトランザクションの中で applyBuildingLink が行う。
 */
import type { Prisma } from "@/generated/prisma";
import { areaKey, buildingNameKey } from "@/lib/building-identity";
import { decideBuildingLink, AUTO_CHOICE } from "./resolve";

export type CsvBuildingResolution =
  | { kind: "link"; buildingId: string }
  | { kind: "create" }
  | { kind: "review"; error: string; candidates: { id: string; name: string; address: string }[] };

export interface CsvBuildingRow {
  id: string;
  name: string;
  address: string;
  nameKey: string | null;
  areaKey: string | null;
  createdAt: Date;
  unitCount: number;
}

const REVIEW_CANDIDATE_LIMIT = 10;
/** key が null の古い棟を、1回の判断で見る上限(apply.ts と同じ)。 */
const NULL_KEY_SCAN_LIMIT = 500;

/**
 * - 同じ町丁目・同じ比べる形の棟がある → link(複数なら decideBuildingLink と同じ選び方)
 * - 無いが、比べる形が同じ別の町丁目の棟か、名前が部分一致する棟がある → review
 *   (⚠以前の「部分一致1件なら黙ってつなぐ」は D2 に反するのでやめた=発注者承認 2026-10-04)
 * - どれも無い → create
 */
export function decideCsvBuilding(input: {
  buildingName: string;
  address: string | undefined;
  sameKey: CsvBuildingRow[];
  others: CsvBuildingRow[];
}): CsvBuildingResolution {
  const nameKey = buildingNameKey(input.buildingName);
  const area = areaKey(input.address);
  if (nameKey && area && input.sameKey.length > 0) {
    const d = decideBuildingLink({
      propertyType: "apartment_unit",
      buildingName: input.buildingName,
      nameKey,
      areaKey: area,
      choice: AUTO_CHOICE,
      current: null,
      chosen: null,
      candidates: input.sameKey.map((b) => ({ id: b.id, name: b.name, unitCount: b.unitCount, createdAt: b.createdAt })),
    });
    if (d.kind === "link") return { kind: "link", buildingId: d.buildingId };
  }
  const seen = new Set(input.sameKey.map((b) => b.id));
  const candidates = input.others
    .filter((b) => !seen.has(b.id))
    .slice(0, REVIEW_CANDIDATE_LIMIT)
    .map((b) => ({ id: b.id, name: b.name, address: b.address }));
  if (candidates.length > 0) {
    return {
      kind: "review",
      // ⚠「棟名」で始める(取込詳細の絞り込み building_unresolved と表示の判定が prefix で拾う)。
      error: `棟名「${input.buildingName}」に似た棟が${candidates.length}件あります。同じ建物ならレビュー画面で選んでください`,
      candidates,
    };
  }
  return { kind: "create" };
}

type Row = {
  id: string;
  name: string;
  address: string;
  nameKey: string | null;
  areaKey: string | null;
  createdAt: Date;
  _count: { properties: number };
};

/** prisma 本体も tx も渡せる(テストは `as never` で偽物を渡す)。 */
export type CsvResolveDb = { building: Pick<Prisma.TransactionClient["building"], "findMany"> };

const toRow = (b: Row): CsvBuildingRow => ({
  id: b.id,
  name: b.name,
  address: b.address,
  nameKey: b.nameKey,
  areaKey: b.areaKey,
  createdAt: b.createdAt,
  unitCount: b._count.properties,
});

function pushUnique(list: CsvBuildingRow[], b: CsvBuildingRow): void {
  if (!list.some((x) => x.id === b.id)) list.push(b);
}

export async function resolveCsvBuilding(
  db: CsvResolveDb,
  buildingName: string,
  address: string | undefined,
  cache: Map<string, CsvBuildingResolution>,
): Promise<CsvBuildingResolution> {
  const trimmed = buildingName.trim();
  const nameKey = buildingNameKey(trimmed);
  const area = areaKey(address);
  const cacheKey = `${nameKey ?? ""}|||${area ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const select = {
    id: true, name: true, address: true, nameKey: true, areaKey: true, createdAt: true,
    _count: { select: { properties: true } },
  } as const;
  const sameKey: CsvBuildingRow[] = [];
  if (nameKey && area) {
    for (const b of await db.building.findMany({ where: { areaKey: area, nameKey }, select })) {
      pushUnique(sameKey, toRow(b));
    }
  }
  const others: CsvBuildingRow[] = [];
  // key が null の古い棟は、その場で計算して振り分ける(CSV は読むだけ=埋めるのは apply 側)。
  const unkeyed = await db.building.findMany({
    where: { nameKey: null }, select, take: NULL_KEY_SCAN_LIMIT, orderBy: { createdAt: "asc" },
  });
  for (const raw of unkeyed) {
    const b = toRow(raw);
    const k = buildingNameKey(b.name);
    const a = areaKey(b.address);
    if (nameKey !== null && k === nameKey && area !== null && a === area) pushUnique(sameKey, b);
    else if ((nameKey !== null && k === nameKey) || (trimmed !== "" && b.name.includes(trimmed))) pushUnique(others, b);
  }
  if (nameKey) {
    const sameNameOtherArea = await db.building.findMany({ where: { nameKey }, select, take: REVIEW_CANDIDATE_LIMIT });
    const partial = await db.building.findMany({
      where: { name: { contains: trimmed } }, select, take: REVIEW_CANDIDATE_LIMIT,
    });
    for (const b of [...sameNameOtherArea, ...partial]) pushUnique(others, toRow(b));
  }
  const result = decideCsvBuilding({ buildingName: trimmed, address, sameKey, others });
  // ⚠create は覚えない(同じ取込の次の行は、前の行が作った棟を link で見つける=Review Focus 4)。
  if (result.kind !== "create") cache.set(cacheKey, result);
  return result;
}
