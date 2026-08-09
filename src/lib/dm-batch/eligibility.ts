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
//   (2) terminal反響(拒否/宛先不明)が付いた宛先 → 409(terminalReactionCount。
//       代表or共有者の誰かが terminalOwnerIds(他物件も含む所有者横断の集合=R29)に
//       含まれれば検出。控えが古いまま除外済みの相手へ郵送するのを防ぐ=R42・PR-B)
//   (3) 送付資格: PropertyOwner リンク切れ / dmStatus!="send" / isArchived → 409(stateIssueCount)
//   (4) owner/property 削除で null の item → 初回GETで物理削除(prunedItemIds)
//   (6) 住所グループ再計算との完全一致 → 409(groupMismatchCount)
//   (7) 同一物件内で同じ現在グループを指す item の重複 → 409(groupMismatchCount。
//       名寄せで別グループだった2itemが同一グループに合流すると、CSVが同じ宛先に
//       2通出て確定も二重記録になる=#364 R8。再出力すれば1通に畳まれる)
// (5) 再送候補述語の再評価は PR-C でこの関数に追加する。

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
  /** (2) 拒否/宛先不明の反響が付いた所有者(代表or共有者)を含む item 数 → 409(PR-B) */
  terminalReactionCount: number;
}

type OwnerWithId = DmRowPropertyOwner & { owner: { id: string } };

export function checkBatchEligibility(
  items: BatchItemForCheck[],
  properties: Map<string, PropertyStateForCheck>,
  session: { id: string; role: string },
  /** 拒否/宛先不明の反響を持つ所有者 id 集合(他物件も含む所有者横断=呼び出し側が
   *  Owner FOR SHARE 保持中に propertyDmLog から構築する。省略時=検査(2)なし)。 */
  terminalOwnerIds: ReadonlySet<string> = new Set(),
): EligibilityResult {
  const prunedItemIds: string[] = [];
  let scopeMissingCount = 0;
  let stateIssueCount = 0;
  let groupMismatchCount = 0;
  let terminalReactionCount = 0;
  const seenGroups = new Set<string>();

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
    // (2) 代表or共有者の誰かに terminal 反響(拒否/宛先不明)が付いていれば除外対象(R29/R42)
    if (
      terminalOwnerIds.has(it.ownerId) ||
      it.groupOwnerIds.some((oid) => terminalOwnerIds.has(oid))
    ) {
      terminalReactionCount += 1;
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
      continue;
    }
    // (7) 同一物件内の重複グループ検出(現在の代表で同定=#364 R8)。
    const groupKey = `${it.propertyId}:${it.ownerId}`;
    if (seenGroups.has(groupKey)) {
      groupMismatchCount += 1;
      continue;
    }
    seenGroups.add(groupKey);
  }

  return {
    prunedItemIds,
    scopeMissingCount,
    stateIssueCount,
    groupMismatchCount,
    terminalReactionCount,
  };
}
