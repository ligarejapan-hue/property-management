import prisma from "@/lib/prisma";
import { normalizeName, normalizeAddress } from "@/lib/normalize";
import { samePhoneNumber } from "@/lib/phone-format-jp";

export function buildOwnerDedupKey(name: string, address: string): string {
  return `${normalizeName(name)}::${normalizeAddress(address)}`;
}

/**
 * 単一行向けの所有者重複検索。owner-csv 初期インポートと同じ優先順位で判定する。
 *   第一: address あり → normalizeName + normalizeAddress 一致
 *   第二: phone あり → name + phone の生値一致
 *   第三: いずれも無ければ null（誤統合防止のため name 単独検索はしない）
 */
export async function findDuplicateOwner(input: {
  name: string;
  address?: string | null;
  phone?: string | null;
}): Promise<{ id: string; name: string } | null> {
  const name = input.name.trim();
  if (!name) return null;

  const address = input.address?.trim() ?? "";
  const phone = input.phone?.trim() ?? "";

  if (address) {
    const key = buildOwnerDedupKey(name, address);
    const candidates = await prisma.owner.findMany({
      where: { address: { not: null }, isArchived: false },
      select: { id: true, name: true, address: true },
    });
    for (const c of candidates) {
      if (c.address && buildOwnerDedupKey(c.name, c.address) === key) {
        return { id: c.id, name: c.name };
      }
    }
  }

  if (phone) {
    const hit = await findOwnerByNameAndPhone(name, phone);
    if (hit) return hit;
  }

  return null;
}

/**
 * 氏名が同じで、電話番号が**同じ番号**の所有者(整理済みを除く)。
 * 手で区切った番号を残すため、保存済みの書き方は決まった形にならない(0422-12-3456 も
 * 042-212-3456 もありうる)。書き方を並べて照らすと取りこぼすので、同じ氏名の候補を取り出し、
 * **両方を数字だけにして**比べる(samePhoneNumber・@codex P1 #455)。同じ氏名の所有者は少ない。
 * 並びは登録の古い順(以前の findFirst は順不同だった=結果を安定させる)。
 */
export async function findOwnerByNameAndPhone(
  name: string,
  phone: string,
): Promise<{ id: string; name: string } | null> {
  const candidates = await prisma.owner.findMany({
    where: { name, isArchived: false, phone: { not: null } },
    select: { id: true, name: true, phone: true },
    orderBy: { createdAt: "asc" },
  });
  const hit = candidates.find((c) => samePhoneNumber(c.phone, phone));
  return hit ? { id: hit.id, name: hit.name } : null;
}
