/** 名簿の読み込みの DB 側。1回 500 件を1つのトランザクションで入れる/更新する。 */
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import type { CatalogStore } from "./load";
import type { CatalogRow } from "./parse";

const data = (r: CatalogRow) => ({
  name: r.name,
  address: r.address,
  prefCode: r.prefCode,
  stations: r.stations,
  builtYear: r.builtYear,
  builtMonth: r.builtMonth,
  totalFloors: r.totalFloors,
  basementFloors: r.basementFloors,
  totalUnits: r.totalUnits,
  structureType: r.structureType,
  developer: r.developer,
  managementCompany: r.managementCompany,
  raw: r.raw as Prisma.InputJsonValue,
  nameKey: r.nameKey,
  areaKey: r.areaKey,
  fetchedAt: r.fetchedAt,
});

export function createPrismaCatalogStore(): CatalogStore {
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return { inserted: 0, updated: 0 };
      return prisma.$transaction(async (tx) => {
        const existing = await tx.mansionCatalog.findMany({
          where: { OR: rows.map((r) => ({ source: r.source, sourceId: r.sourceId })) },
          select: { source: true, sourceId: true },
        });
        const have = new Set(existing.map((e) => `${e.source}:${e.sourceId}`));
        for (const r of rows) {
          await tx.mansionCatalog.upsert({
            where: { source_sourceId: { source: r.source, sourceId: r.sourceId } },
            create: { source: r.source, sourceId: r.sourceId, ...data(r) },
            update: data(r),
          });
        }
        const updated = rows.filter((r) => have.has(`${r.source}:${r.sourceId}`)).length;
        return { inserted: rows.length - updated, updated };
      }, { timeout: 60_000 });
    },
  };
}
