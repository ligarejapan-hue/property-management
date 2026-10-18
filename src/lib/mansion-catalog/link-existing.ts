/**
 * 今ある棟のうち名簿とつながっていないものを、名簿に**ちょうど1件**一致すればつなぐ(設計 §6.4)。
 * 作らない(adopt の create:false)。空いている欄だけ埋まる。
 */
import prisma from "@/lib/prisma";
import { areaKey as toAreaKey, buildingNameKey } from "@/lib/building-identity";
import { adoptCatalogBuilding, type AdoptResult, type AdoptTx } from "./adopt";

export async function linkExistingBuildings(deps: {
  listUnlinked(): Promise<{ id: string; name: string; address: string; nameKey: string | null; areaKey: string | null }[]>;
  findCatalogIds(areaKey: string, nameKey: string): Promise<string[]>;
  adopt(catalogId: string): Promise<AdoptResult>;
}): Promise<number> {
  let linked = 0;
  for (const b of await deps.listUnlinked()) {
    // ⚠[@codex] 比べる形が入る前の古い棟は、名前と住所からその場で計算する(飛ばすと、つながらない
    //   うえに名簿の段に同じ建物が残り、「マンション棟に登録」で棟が2つになる)。
    const nameKey = b.nameKey ?? buildingNameKey(b.name);
    const area = b.nameKey === null ? toAreaKey(b.address) : b.areaKey;
    if (nameKey === null || area === null) continue;
    const ids = await deps.findCatalogIds(area, nameKey);
    if (ids.length !== 1) continue;
    const r = await deps.adopt(ids[0]);
    if (r.kind === "linked") linked++;
  }
  return linked;
}

export function createPrismaLinkDeps(): Parameters<typeof linkExistingBuildings>[0] {
  return {
    listUnlinked: () => prisma.building.findMany({ where: { catalogId: null }, select: { id: true, name: true, address: true, nameKey: true, areaKey: true } }),
    findCatalogIds: async (areaKey, nameKey) =>
      (await prisma.mansionCatalog.findMany({ where: { areaKey, nameKey }, select: { id: true }, take: 2 })).map((r) => r.id),
    adopt: (catalogId) => prisma.$transaction((tx) => adoptCatalogBuilding(tx as unknown as AdoptTx, catalogId, null, { create: false })),
  };
}
