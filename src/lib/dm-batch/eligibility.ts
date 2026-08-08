import {
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import { canAccessPropertyRecord } from "@/lib/property-access";

// 宛先資格の再検証(設計書 2026-08-08-dm-sending-management-design.md §2.1)。
// 控えの items を「現在の」物件・所有者状態と突き合わせる純関数。DL両経路(初回/再試行)と
// 確定前の検査で共通利用し、条件の食い違い(R53)を作らない。
//   (1) record scope 欠け → 403(scopeMissingCount)
//   (3) 送付資格: PropertyOwner リンク切れ / dmStatus!="send" / isArchived → 409(stateIssueCount)
//   (4) owner/property 削除で null の item → 初回GETで物理削除(prunedItemIds)
//   (6) 住所グループ再計算との完全一致 → 409(groupMismatchCount)
// (2) terminal反響は PR-B、(5) 再送候補述語の再評価は PR-C でこの関数に追加する。

export interface BatchItemForCheck {
  id: string;
  propertyId: string | null;
  ownerId: string | null;
  /** item_owners 連関の全員(代表含む) */
  groupOwnerIds: string[];
}

export interface PropertyStateForCheck {
  id: string;
  dmStatus: string;
  isArchived: boolean;
  createdBy: string;
  assignedTo: string | null;
  /** 現在の PropertyOwner(非アーカイブ)。グループ再計算(R51)にも使う。 */
  propertyOwners: Array<{
    isPrimary: boolean;
    relationship: string | null;
    owner: {
      id: string;
      name: string | null;
      nameKana: string | null;
      zip: string | null;
      address: string | null;
      corporateNumber: string | null;
    };
  }>;
}

export interface EligibilityResult {
  /** (4) owner/property 削除で null になった item(初回GETのみ物理削除・再試行は409) */
  prunedItemIds: string[];
  /** (1) record scope で欠ける item 数 → 403 */
  scopeMissingCount: number;
  /** (3) リンク切れ or 送付不能(dmStatus!=send / isArchived)の item 数 → 409 */
  stateIssueCount: number;
  /** (6) 住所グループ再計算と不一致の item 数 → 409 */
  groupMismatchCount: number;
}

type OwnerWithId = DmRowPropertyOwner & { owner: { id: string } };

export function checkBatchEligibility(
  items: BatchItemForCheck[],
  properties: Map<string, PropertyStateForCheck>,
  session: { id: string; role: string },
): EligibilityResult {
  const prunedItemIds: string[] = [];
  let scopeMissingCount = 0;
  let stateIssueCount = 0;
  let groupMismatchCount = 0;

  for (const it of items) {
    const property = it.propertyId ? properties.get(it.propertyId) : undefined;
    // (4) 参照が欠けた item は郵送不能=検査対象から外して除外扱い
    if (!it.ownerId || !it.propertyId || !property) {
      prunedItemIds.push(it.id);
      continue;
    }
    // (1) record scope(担当替えで欠けたら全体を配らない)
    if (!canAccessPropertyRecord(session, property)) {
      scopeMissingCount += 1;
      continue;
    }
    // (3) 送付可能条件は既存 export と同一の完全形(dmStatus=send かつ 未アーカイブ=R52)
    if (property.dmStatus !== "send" || property.isArchived) {
      stateIssueCount += 1;
      continue;
    }
    // (3) 共有者全員が今も PropertyOwner でこの物件に紐づいているか(R48)
    const linked = new Set(property.propertyOwners.map((po) => po.owner.id));
    if (!it.groupOwnerIds.every((oid) => linked.has(oid))) {
      stateIssueCount += 1;
      continue;
    }
    // (6) 現在値でグループ再計算し、この item の代表が属すグループと保存集合の完全一致を要求(R51)
    const { groups } = groupPropertyOwnersByAddress(
      property.propertyOwners as OwnerWithId[],
    );
    const current = groups.find(
      (g) => (selectGroupRepresentative(g) as OwnerWithId).owner.id === it.ownerId,
    );
    const currentIds = new Set(
      (current ?? []).map((po) => (po as OwnerWithId).owner.id),
    );
    const saved = new Set(it.groupOwnerIds);
    const same =
      currentIds.size === saved.size &&
      [...saved].every((x) => currentIds.has(x));
    if (!same) {
      groupMismatchCount += 1;
    }
  }

  return { prunedItemIds, scopeMissingCount, stateIssueCount, groupMismatchCount };
}
