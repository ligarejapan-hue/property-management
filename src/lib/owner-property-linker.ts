import prisma from "@/lib/prisma";
import { normalizeAddress } from "@/lib/address-normalizer";

/**
 * Owner ↔ Property の自動リンク処理。
 *
 * 戦略:
 *  (1) Owner.externalLinkKey と Property.externalLinkKey の完全一致 (全件リンク)
 *  (2) 住所 (正規化後) の完全一致 (候補が 1 件に絞れる場合のみ)
 *
 * 既存の PropertyOwner が存在する組み合わせはスキップ (再実行安全)。
 * 共有名義 (同一物件に複数 Owner) は壊さない: PropertyOwner の
 * @@unique([propertyId, ownerId]) を尊重しつつ、別 Owner の追加は通常通り行う。
 *
 * `ownerIds` を渡した場合: その Owner のみが対象 (新規取込フロー用)。
 * 省略した場合: PropertyOwner を 1 件も持たない既存 Owner を対象 (救済用)。
 */
export interface RelinkResult {
  candidateOwnerCount: number;
  linkedCount: number;
  linkedByLinkKeyCount: number;
  linkedByAddressCount: number;
  addressLinkAmbiguousCount: number;
}

export async function relinkOwnersToProperties(
  ownerIds?: string[],
): Promise<RelinkResult> {
  let linkedCount = 0;
  let linkedByLinkKeyCount = 0;
  let linkedByAddressCount = 0;
  let addressLinkAmbiguousCount = 0;

  if (ownerIds && ownerIds.length === 0) {
    return {
      candidateOwnerCount: 0,
      linkedCount,
      linkedByLinkKeyCount,
      linkedByAddressCount,
      addressLinkAmbiguousCount,
    };
  }

  // ownerIds 指定なし → 「PropertyOwner を 1 件も持たない Owner」を救済対象に。
  const baseWhere: Record<string, unknown> = ownerIds
    ? { id: { in: ownerIds } }
    : { propertyOwners: { none: {} }, isArchived: false };

  // (1) externalLinkKey 経由
  const ownersWithLinkKey = await prisma.owner.findMany({
    where: { ...baseWhere, externalLinkKey: { not: null } },
    select: { id: true, externalLinkKey: true },
  });

  const linkedOwnerIds = new Set<string>();
  for (const owner of ownersWithLinkKey) {
    if (!owner.externalLinkKey) continue;
    const matchingProperties = await prisma.property.findMany({
      where: { externalLinkKey: owner.externalLinkKey },
      select: { id: true },
    });
    for (const property of matchingProperties) {
      const created = await tryCreateLink(property.id, owner.id);
      if (created) {
        linkedCount++;
        linkedByLinkKeyCount++;
        linkedOwnerIds.add(owner.id);
      }
    }
  }

  // (2) 住所フォールバック
  const addressTargets = await prisma.owner.findMany({
    where: { ...baseWhere, address: { not: null } },
    select: { id: true, address: true },
  });

  const propertyByNormAddr = new Map<string, string[]>();
  for (const owner of addressTargets) {
    if (linkedOwnerIds.has(owner.id)) continue;
    if (!owner.address) continue;
    const norm = normalizeAddress(owner.address);
    if (!norm) continue;

    let candidates = propertyByNormAddr.get(norm);
    if (!candidates) {
      const cands = await prisma.property.findMany({
        where: { address: { contains: owner.address.slice(0, 8) } },
        select: { id: true, address: true },
      });
      candidates = cands
        .filter((p) => normalizeAddress(p.address) === norm)
        .map((p) => p.id);
      propertyByNormAddr.set(norm, candidates);
    }

    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      addressLinkAmbiguousCount++;
      continue; // 安全側: 自動リンクしない
    }
    const created = await tryCreateLink(candidates[0], owner.id);
    if (created) {
      linkedCount++;
      linkedByAddressCount++;
      linkedOwnerIds.add(owner.id);
    }
  }

  // candidate は (1)(2) の和集合（重複除去）
  const candidateSet = new Set<string>([
    ...ownersWithLinkKey.map((o) => o.id),
    ...addressTargets.map((o) => o.id),
  ]);

  return {
    candidateOwnerCount: candidateSet.size,
    linkedCount,
    linkedByLinkKeyCount,
    linkedByAddressCount,
    addressLinkAmbiguousCount,
  };
}

async function tryCreateLink(
  propertyId: string,
  ownerId: string,
): Promise<boolean> {
  const existing = await prisma.propertyOwner.findUnique({
    where: { propertyId_ownerId: { propertyId, ownerId } },
  });
  if (existing) return false;
  await prisma.propertyOwner.create({
    data: {
      propertyId,
      ownerId,
      relationship: "所有者",
      isPrimary: false,
    },
  });
  return true;
}
