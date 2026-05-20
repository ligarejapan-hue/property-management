/**
 * Phase 2-B-α: duplicate グループの master / source ペア選択ロジック。
 *
 * UI 側のラジオで master / source を選び直すときに、ペアが同一 owner にならず
 * かつ「役割の入れ替え」がスムーズに行えるよう swap を組み込んだ純関数。
 *
 * 設計方針:
 *   - radio を disabled にしない（一度選ぶと役割を入れ替えられないため）。
 *   - 相手側に既に選ばれている owner を選んだら、role を入れ替える (swap)。
 *   - 2 人グループでも 3 人以上でも自然に動く。
 *   - 純関数として React 外でも単体テスト可能。
 */

export interface MergePair {
  masterId: string | null;
  sourceId: string | null;
}

/**
 * master 側で id を選択した結果のペアを返す。
 * 同じ owner が source に既に選ばれていれば swap する。
 */
export function applyMasterSelection(
  pair: MergePair,
  id: string,
): MergePair {
  if (pair.sourceId === id) {
    return { masterId: id, sourceId: pair.masterId };
  }
  return { masterId: id, sourceId: pair.sourceId };
}

/**
 * source 側で id を選択した結果のペアを返す。
 * 同じ owner が master に既に選ばれていれば swap する。
 */
export function applySourceSelection(
  pair: MergePair,
  id: string,
): MergePair {
  if (pair.masterId === id) {
    return { masterId: pair.sourceId, sourceId: id };
  }
  return { masterId: pair.masterId, sourceId: id };
}
