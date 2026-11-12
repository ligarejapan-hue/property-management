/**
 * 登記上の記載(所有者事項の行ごとの住所と持分)を記録する(2026-11-12 発注者決定)。
 *
 * - 所有者事項の1行 = 1件。同じ人が住所違い・持分ごとに何行も載るとき、所有者は1人のまま
 *   行をそのまま残す(position = その書類の全所有者を通した行の順・1始まり)。
 * - 取り込みのたびに、**その取り込みに出てきた所有者の分だけ**入れ替える(書類に出てこなかった
 *   所有者の行は触らない)。
 * ⚠所有者事項の行の順に新旧の意味は無い。
 */
import { parseRegistryShare } from "@/lib/registry-entries/share";

/** 取り込みで読んだ1行と、その行をどの所有者に当てたか。 */
export interface RegistryEntrySourceRow {
  ownerId: string;
  address: string | null;
  /** 読み取ったままの持分(「10分の2」)。無ければ null。 */
  share: string | null;
}

export interface PlannedRegistryEntry {
  position: number;
  address: string | null;
  shareNum: number | null;
  shareDen: number | null;
}

/** 行の順のまま、所有者ごとに分ける(純関数)。position は書類全体を通した番号。 */
export function planRegistryEntries(
  rows: ReadonlyArray<RegistryEntrySourceRow>,
): Map<string, PlannedRegistryEntry[]> {
  const byOwner = new Map<string, PlannedRegistryEntry[]>();
  rows.forEach((row, i) => {
    const share = parseRegistryShare(row.share);
    const address = row.address?.trim() ? row.address.trim() : null;
    const list = byOwner.get(row.ownerId) ?? [];
    list.push({
      position: i + 1,
      address,
      shareNum: share?.num ?? null,
      shareDen: share?.den ?? null,
    });
    byOwner.set(row.ownerId, list);
  });
  return byOwner;
}

/** replaceRegistryEntries が使う DB の口(prisma でもトランザクションでも渡せる最小の形)。 */
interface EntriesDb {
  propertyOwner: {
    findMany(args: {
      where: { propertyId: string; ownerId: { in: string[] } };
      select: { id: true; ownerId: true };
    }): Promise<Array<{ id: string; ownerId: string }>>;
  };
  propertyOwnerRegistryEntry: {
    deleteMany(args: { where: { propertyOwnerId: { in: string[] } } }): Promise<unknown>;
    createMany(args: {
      data: Array<{
        propertyOwnerId: string;
        position: number;
        address: string | null;
        shareNum: number | null;
        shareDen: number | null;
        sourceAttachmentId: string | null;
      }>;
    }): Promise<unknown>;
  };
}

/**
 * その物件の、取り込みに出てきた所有者の行を入れ替える。
 * ⚠呼ぶ側が物件行を押さえたトランザクションの中で呼ぶ(同じ物件への同時取込を直列にする)。
 * 物件に紐づいていない所有者の行は捨てる(つながりが無ければ記録先が無い)。
 * @returns 記録した行の数
 */
export async function replaceRegistryEntries(
  db: EntriesDb,
  propertyId: string,
  rows: ReadonlyArray<RegistryEntrySourceRow>,
  sourceAttachmentId: string | null = null,
): Promise<number> {
  const plan = planRegistryEntries(rows);
  if (plan.size === 0) return 0;
  const links = await db.propertyOwner.findMany({
    where: { propertyId, ownerId: { in: [...plan.keys()] } },
    select: { id: true, ownerId: true },
  });
  if (links.length === 0) return 0;
  await db.propertyOwnerRegistryEntry.deleteMany({
    where: { propertyOwnerId: { in: links.map((l) => l.id) } },
  });
  const data = links.flatMap((l) =>
    (plan.get(l.ownerId) ?? []).map((e) => ({
      propertyOwnerId: l.id,
      position: e.position,
      address: e.address,
      shareNum: e.shareNum,
      shareDen: e.shareDen,
      sourceAttachmentId,
    })),
  );
  if (data.length === 0) return 0;
  await db.propertyOwnerRegistryEntry.createMany({ data });
  return data.length;
}
