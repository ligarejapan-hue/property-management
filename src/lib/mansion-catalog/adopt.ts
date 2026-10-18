/**
 * 名簿の建物を「マンション棟」にする(設計 2026-10-18 §5)。どの入口もここを通す。
 * ⚠必ず呼ぶ側のトランザクションの tx を渡す。ロックの鍵は物件の保存(applyBuildingLink)と同じ
 *   buildingLinkLockKey=同時に来た保存と取り込みが同じ建物の棟を2つ作らない。
 * ⚠社内の棟は**空いている欄だけ**埋める。名前・住所・手で入れた値は変えない。
 */
import type { Prisma } from "@/generated/prisma";
import { buildingLinkLockKey } from "@/lib/building-link/resolve";
import { BUILDING_TRACKED_FIELDS, recordChangesInTx } from "@/lib/change-log";

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
  changeLog: Pick<Prisma.TransactionClient["changeLog"], "createMany">;
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
  // 監査には id と埋めた欄の名前だけ(値・住所・建物名は書かない)。
  const audit = (buildingId: string, kind: "linked" | "created", filled?: string[]) =>
    tx.auditLog.create({
      data: {
        userId, action: "building.catalog_adopt", targetTable: "buildings", targetId: buildingId,
        detail: { catalogId: c.id, kind, ...(filled ? { filled } : {}) },
      },
    });
  if (sameKey.length === 1 && sameKey[0].catalogId === null) {
    const before = { ...sameKey[0] }; // 履歴の「前の値」(更新の前に写しておく)
    const fill = fillEmptyFromCatalog(before, c);
    // ⚠版番号を進める(棟の編集画面を開いたままの人が古い版で保存すると 409 になる=埋めた値を
    //   空欄で上書きして消さない)。⚠この UPDATE は catalog_id(一意索引つき)を変えるので棟の行に
    //   FOR UPDATE 相当のロックがかかる。ここの後は何も待たないので、待ちの輪は作らない。
    const b = await tx.building.update({
      where: { id: sameKey[0].id },
      data: { catalogId: c.id, ...fill, version: { increment: 1 } },
      select: { id: true, name: true },
    });
    // 棟の変更履歴(人が押したときだけ。読み込みの後処理は人がいないので監査の filled で残す)。
    if (userId !== null) {
      await recordChangesInTx(tx, {
        targetTable: "buildings",
        targetId: b.id,
        changedBy: userId,
        oldValues: before,
        newValues: fill,
        trackedFields: BUILDING_TRACKED_FIELDS,
        source: "api",
      });
    }
    await audit(b.id, "linked", Object.keys(fill));
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
