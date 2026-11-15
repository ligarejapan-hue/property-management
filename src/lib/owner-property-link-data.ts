/**
 * 所有者補正候補の各タブ(法人番号・法人番号紐づけ・住所の登記文字列)の行に、
 * 「その所有者の物件へ飛ぶリンク」の材料を足す(2026-11-16 発注者の指摘=物件に飛べない)。
 *
 * 決まりは最初のタブ(全て・孤立・住所なし・重複候補)の API(correction-candidates)と同じ:
 *  - count=つながっている物件の数(可視範囲で絞らない。孤立の判定と同じ数え方)
 *  - singlePropertyId=見られる物件がちょうど1件のときだけ、その物件の id
 *  - hasReachableProperty=このビューアが見られる物件が1件以上あるか
 *  - available=property:read があるか。無ければ物件由来の値(id・見られるか)は一切返さない
 * ⚠物件の id と「見られるか」は、物件一覧・詳細と同じ可視範囲(propertyVisibilityScopeWhere)で絞る。
 *   現地担当に、担当外の物件の id を渡さない。
 * ⚠全所有者を走査する API なので、**その頁に出す所有者の分だけ**を後から1回で引く。
 */

import { hasPermission } from "@/lib/permissions";
import { propertyVisibilityScopeWhere } from "@/lib/property-list-query";
import { pickSinglePropertyId } from "@/lib/owner-property-link";

export interface OwnerPropertyLinkInfo {
  count: number;
  singlePropertyId: string | null;
  hasReachableProperty: boolean;
  available: boolean;
}

type Perms = Parameters<typeof hasPermission>[0];
type Session = Parameters<typeof propertyVisibilityScopeWhere>[0];

interface LinkRow {
  id: string;
  _count: { propertyOwners: number };
  propertyOwners?: Array<{ propertyId: string }>;
}

/** db に要求する最小の形(実 Prisma / route テストの mock の両方が満たす)。 */
export interface OwnerPropertyLinkDb {
  owner: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export async function loadOwnerPropertyLinkInfo(
  db: OwnerPropertyLinkDb,
  ownerIds: readonly string[],
  session: Session,
  perms: Perms,
): Promise<Map<string, OwnerPropertyLinkInfo>> {
  const out = new Map<string, OwnerPropertyLinkInfo>();
  const ids = [...new Set(ownerIds)];
  if (ids.length === 0) return out;
  const available = hasPermission(perms, "property", "read");
  const scope = propertyVisibilityScopeWhere(session);
  const rows = (await db.owner.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      _count: { select: { propertyOwners: true } },
      // property:read が無いセッションでは、物件の行そのものを読まない。
      ...(available
        ? {
            propertyOwners: {
              select: { propertyId: true },
              // ちょうど1件か、2件以上かが分かれば足りる。
              take: 2,
              ...(scope ? { where: { property: scope } } : {}),
            },
          }
        : {}),
    },
  })) as LinkRow[];
  for (const r of rows) {
    const reachable = available ? (r.propertyOwners ?? []) : [];
    out.set(r.id, {
      count: r._count.propertyOwners,
      singlePropertyId: available ? pickSinglePropertyId(reachable) : null,
      hasReachableProperty: reachable.length > 0,
      available,
    });
  }
  return out;
}

/** 行に propertyLink を足す(引けなかった所有者は「物件なし・リンクなし」)。 */
export function withOwnerPropertyLink<T extends { ownerId: string }>(
  rows: readonly T[],
  info: ReadonlyMap<string, OwnerPropertyLinkInfo>,
): Array<T & { propertyLink: OwnerPropertyLinkInfo }> {
  return rows.map((r) => ({
    ...r,
    propertyLink:
      info.get(r.ownerId) ?? { count: 0, singlePropertyId: null, hasReachableProperty: false, available: false },
  }));
}
