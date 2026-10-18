/**
 * 今ある棟のうち名簿とつながっていないものを、名簿に**ちょうど1件**一致すればつなぐ(設計 §6.4)。
 * 作らない(adopt の create:false)。空いている欄だけ埋まる。
 */
import prisma from "@/lib/prisma";
import { adoptCatalogBuilding, type AdoptResult, type AdoptTx } from "./adopt";

export async function linkExistingBuildings(deps: {
  listUnlinked(): Promise<{ id: string; nameKey: string | null; areaKey: string | null }[]>;
  findCatalogIds(areaKey: string, nameKey: string): Promise<string[]>;
  adopt(catalogId: string): Promise<AdoptResult>;
}): Promise<number> {
  let linked = 0;
  for (const b of await deps.listUnlinked()) {
    if (b.nameKey === null || b.areaKey === null) continue;
    const ids = await deps.findCatalogIds(b.areaKey, b.nameKey);
    if (ids.length !== 1) continue;
    const r = await deps.adopt(ids[0]);
    if (r.kind === "linked") linked++;
  }
  return linked;
}

export function createPrismaLinkDeps(): Parameters<typeof linkExistingBuildings>[0] {
  return {
    listUnlinked: () => prisma.building.findMany({ where: { catalogId: null }, select: { id: true, nameKey: true, areaKey: true } }),
    findCatalogIds: async (areaKey, nameKey) =>
      (await prisma.mansionCatalog.findMany({ where: { areaKey, nameKey }, select: { id: true }, take: 2 })).map((r) => r.id),
    adopt: (catalogId) => prisma.$transaction((tx) => adoptCatalogBuilding(tx as unknown as AdoptTx, catalogId, null, { create: false })),
  };
}
