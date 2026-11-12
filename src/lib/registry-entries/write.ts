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
import { pickSamePropertyOwner } from "@/lib/registry-pdf/owner-reuse";

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

/** moveRegistryEntriesToLink が使う DB の口。 */
interface MoveEntriesDb {
  propertyOwnerRegistryEntry: {
    findMany(args: {
      where: { propertyOwnerId: string };
      orderBy: { position: "asc" | "desc" };
      select: { id: true; position: true };
      take?: number;
    }): Promise<Array<{ id: string; position: number }>>;
    update(args: {
      where: { id: string };
      data: { propertyOwnerId: string; position: number };
    }): Promise<unknown>;
  };
}

/**
 * つながり(PropertyOwner)を消す前に、その行を別のつながりへ引き継ぐ(所有者の統合で使う)。
 *
 * なぜ(@codex #714 P2): 所有者の統合は、同じ物件に両方がつながっているとき、消える側の
 * つながりを削除する。行は FK の cascade で一緒に消えるため、消える側にだけ内訳があると
 * 住所と持分の内訳が黙って無くなる(物件と所有者のつながり自体は残る側に生きているのに)。
 * 残る側の行の後ろに、順番を保って足す(position の一意制約に当たらない番号を振る)。
 * @returns 引き継いだ行の数
 */
export async function moveRegistryEntriesToLink(
  db: MoveEntriesDb,
  fromPropertyOwnerId: string,
  toPropertyOwnerId: string,
): Promise<number> {
  if (fromPropertyOwnerId === toPropertyOwnerId) return 0;
  const moving = await db.propertyOwnerRegistryEntry.findMany({
    where: { propertyOwnerId: fromPropertyOwnerId },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  if (moving.length === 0) return 0;
  const last = await db.propertyOwnerRegistryEntry.findMany({
    where: { propertyOwnerId: toPropertyOwnerId },
    orderBy: { position: "desc" },
    select: { id: true, position: true },
    take: 1,
  });
  let next = (last[0]?.position ?? 0) + 1;
  for (const row of moving) {
    await db.propertyOwnerRegistryEntry.update({
      where: { id: row.id },
      data: { propertyOwnerId: toPropertyOwnerId, position: next },
    });
    next += 1;
  }
  return moving.length;
}

/**
 * 所有者事項の行を、物件につながっている所有者に当てる(純関数・添付済みの所有者事項からの
 * 後追いの記録で使う・2026-11-12 第2回)。
 * 同じ物件の中の「同じ人」の決め方は取り込みと同じ(名前を NFKC・空白・異体字でそろえて比べる)。
 * つながっている人に当たらない行(まだ登録されていない人)は捨てる。
 * ⚠住所では当てない(同じ人が住所違いで何行も載るのが、この記録の主題)。
 *
 * @param nameKey 名前をそろえる関数。**名義の確認から呼ぶときは、名義の確認と同じそろえ方**
 *   (ownerNameKey=(株)と株式会社なども同じにする)を渡す。比べる側が「同じ人」とした人の行を、
 *   当てる側が別人として捨てないため(捨てると「試し終えた」印だけ付いて二度と記録されない)。
 *   渡さなければ取り込みと同じそろえ方。
 */
export function assignRegistryRowsToOwners(
  rows: ReadonlyArray<{ name: string; address: string | null; share: string | null }>,
  linkedOwners: ReadonlyArray<{ ownerId: string; name: string; isArchived: boolean }>,
  nameKey?: (name: string) => string,
): RegistryEntrySourceRow[] {
  const out: RegistryEntrySourceRow[] = [];
  for (const row of rows) {
    let hit: { ownerId: string } | null = null;
    if (nameKey) {
      const key = nameKey(row.name);
      // ⚠空どうしを一致させない(名前が読めていない行を巻き込まない)
      if (key) hit = linkedOwners.find((o) => !o.isArchived && nameKey(o.name) === key) ?? null;
    } else {
      hit = pickSamePropertyOwner(linkedOwners, row.name);
    }
    if (hit) out.push({ ownerId: hit.ownerId, address: row.address, share: row.share });
  }
  return out;
}
