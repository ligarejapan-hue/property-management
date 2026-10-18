/**
 * 名簿の建物を「マンション棟」にする(設計 2026-10-18 §5)。どの入口もここを通す。
 * ⚠必ず呼ぶ側のトランザクションの tx を渡す。ロックの鍵は物件の保存(applyBuildingLink)と同じ
 *   buildingLinkLockKey=同時に来た保存と取り込みが同じ建物の棟を2つ作らない。
 * ⚠社内の棟は**空いている欄だけ**埋める。名前・住所・手で入れた値は変えない。
 */
import type { Prisma } from "@/generated/prisma";
import { buildingLinkLockKey } from "@/lib/building-link/resolve";

export interface CatalogEntry {
  id: string; name: string; address: string;
  builtYear: number | null; builtMonth: number | null;
  totalFloors: number | null; basementFloors: number | null; totalUnits: number | null;
  structureType: string | null; managementCompany: string | null;
  nameKey: string | null; areaKey: string | null;
}
export const CATALOG_ENTRY_SELECT = {
  id: true, name: true, address: true, builtYear: true, builtMonth: true, totalFloors: true,
  basementFloors: true, totalUnits: true, structureType: true, managementCompany: true, nameKey: true, areaKey: true,
} as const;
export const CATALOG_FILL_FIELDS = [
  "builtYear", "builtMonth", "totalFloors", "basementFloors", "totalUnits", "structureType", "managementCompany",
] as const;
type CatalogFillField = (typeof CATALOG_FILL_FIELDS)[number];
/** 棟に入れる名簿の値(欄ごとの型のまま・null の欄は含めない)。 */
export type CatalogFill = { [K in CatalogFillField]?: NonNullable<CatalogEntry[K]> };

export function catalogFillValues(c: CatalogEntry): CatalogFill {
  const out: Record<string, unknown> = {};
  for (const f of CATALOG_FILL_FIELDS) if (c[f] !== null) out[f] = c[f];
  return out as CatalogFill;
}
export function fillEmptyFromCatalog(existing: Record<string, unknown>, c: CatalogEntry): CatalogFill {
  const values: Record<string, unknown> = catalogFillValues(c);
  const out: Record<string, unknown> = {};
  for (const f of CATALOG_FILL_FIELDS) {
    if (values[f] !== undefined && (existing[f] === null || existing[f] === undefined)) out[f] = values[f];
  }
  return out as CatalogFill;
}

export type AdoptTx = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  mansionCatalog: Pick<Prisma.TransactionClient["mansionCatalog"], "findUnique">;
  building: Pick<Prisma.TransactionClient["building"], "findFirst" | "findMany" | "create" | "update">;
  auditLog: Pick<Prisma.TransactionClient["auditLog"], "create">;
};
export type AdoptResult =
  | { kind: "existing" | "linked" | "created"; building: { id: string; name: string } }
  | { kind: "ambiguous" }
  | { kind: "not_found" }
  | { kind: "none" };

const BUILDING_FILL_SELECT = {
  id: true, name: true, catalogId: true,
  builtYear: true, builtMonth: true, totalFloors: true, basementFloors: true, totalUnits: true, structureType: true, managementCompany: true,
} as const;

export async function adoptCatalogBuilding(
  tx: AdoptTx,
  catalogId: string,
  userId: string | null,
  opts: { create?: boolean } = {},
): Promise<AdoptResult> {
  const c = await tx.mansionCatalog.findUnique({ where: { id: catalogId }, select: CATALOG_ENTRY_SELECT });
  if (!c) return { kind: "not_found" };
  // ⚠$executeRaw + ::bigint(apply.ts と同じ書き方)。
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${buildingLinkLockKey(c.areaKey, c.nameKey ?? "")})::bigint)`;
  // ロックのあとに読み直す。
  const already = await tx.building.findFirst({ where: { catalogId: c.id }, select: { id: true, name: true } });
  if (already) return { kind: "existing", building: { id: already.id, name: already.name } };
  const sameKey = c.areaKey !== null && c.nameKey !== null
    ? await tx.building.findMany({ where: { areaKey: c.areaKey, nameKey: c.nameKey }, select: BUILDING_FILL_SELECT, take: 3 })
    : [];
  const audit = (buildingId: string, kind: "linked" | "created") =>
    tx.auditLog.create({
      data: { userId, action: "building.catalog_adopt", targetTable: "buildings", targetId: buildingId, detail: { catalogId: c.id, kind } },
    });
  if (sameKey.length === 1 && sameKey[0].catalogId === null) {
    const b = await tx.building.update({
      where: { id: sameKey[0].id },
      data: { catalogId: c.id, ...fillEmptyFromCatalog(sameKey[0], c) },
      select: { id: true, name: true },
    });
    await audit(b.id, "linked");
    return { kind: "linked", building: b };
  }
  if (sameKey.length > 0) return { kind: "ambiguous" };
  if (opts.create === false || userId === null) return { kind: "none" };
  const b = await tx.building.create({
    data: {
      name: c.name, address: c.address, nameKey: c.nameKey, areaKey: c.areaKey, catalogId: c.id, createdBy: userId,
      ...catalogFillValues(c),
    },
    select: { id: true, name: true },
  });
  await audit(b.id, "created");
  return { kind: "created", building: b };
}
