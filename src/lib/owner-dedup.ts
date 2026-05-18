import prisma from "@/lib/prisma";
import { normalizeName, normalizeAddress } from "@/lib/normalize";

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
    const hit = await prisma.owner.findFirst({
      where: { name, phone, isArchived: false },
      select: { id: true, name: true },
    });
    if (hit) return hit;
  }

  return null;
}
