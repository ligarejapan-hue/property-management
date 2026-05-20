/**
 * Phase 2-B-α: Owner merge candidate detection + dryRun preview safety.
 *
 * 重複Owner候補（normalizeName + normalizeAddress 一致）に対する
 * master / source ペアの安全条件チェック。本ファイルは preview のみで使用し、
 * DB を更新する execute は別 PR（Phase 2-B-β）で実装する。
 *
 * 設計方針:
 *   - 純関数で副作用なし。
 *   - 違反は全件返す（UI が一括表示できるように）。
 *   - PII を引数に持たない（id / 件数 / boolean のみ）。
 *   - OwnerMemo の有無は blocker にしない（件数を summary で operator に提示）。
 *   - PropertyOwner の重複（master/source 同一物件に両方紐付き）も blocker にせず
 *     summary 件数で提示する（execute 時に source 側を破棄する設計のため）。
 *   - archived owner は preview 段階で blocker にする（execute は archived を扱わない）。
 *   - source 側の手動編集履歴（ChangeLog / note / externalLinkKey / version>1）は
 *     blocker（情報が消える危険を operator に明示するため）。
 */

export type OwnerMergeBlockReason =
  | "same_owner_id"                  // master と source の id が同一
  | "master_not_found"               // master owner が存在しない
  | "source_not_found"               // source owner が存在しない
  | "master_archived"                // master が isArchived=true
  | "source_archived"                // source が isArchived=true
  | "source_has_changelog"           // source に手動編集履歴あり
  | "source_has_note"                // source.note 入力済み
  | "source_has_external_link_key"   // source.externalLinkKey 入力済み
  | "source_version_gt_1"            // source.version > 1（編集履歴あり）
  | "name_address_normalize_mismatch"; // 正規化キーが master と一致しない（別人の可能性）

export interface OwnerMergeSafetyInput {
  /** master と source が同一 owner ならば true。 */
  sameOwnerId: boolean;
  /** master owner が DB に存在するか。 */
  masterExists: boolean;
  /** source owner が DB に存在するか。 */
  sourceExists: boolean;
  /** master.isArchived。masterExists=true のときのみ意味を持つ。 */
  masterIsArchived: boolean;
  /** source.isArchived。sourceExists=true のときのみ意味を持つ。 */
  sourceIsArchived: boolean;
  /** source に対する ChangeLog 件数（targetTable="owners", targetId=source.id）。 */
  sourceChangeLogCount: number;
  /** source.note が非空なら true。 */
  sourceHasNote: boolean;
  /** source.externalLinkKey が非空なら true。 */
  sourceHasExternalLinkKey: boolean;
  /** source.version 値。>1 なら手動編集履歴あり。 */
  sourceVersion: number;
  /**
   * master と source の (normalizeName + normalizeAddress) が一致するか。
   * candidate API が出した duplicate グループは原則一致するはずだが、
   * 個別ペアで execute 直前に再検証する。一致しない場合は別人の可能性。
   */
  normalizeKeyMatches: boolean;
}

export type OwnerMergeSafetyResult =
  | { ok: true }
  | { ok: false; reasons: OwnerMergeBlockReason[] };

/**
 * Owner merge の安全条件チェック。
 *
 * 複数違反は全件返す。値（PII）は含めず enum コードのみ。
 *
 * 注意: ここで OwnerMemo 件数や PropertyOwner 件数は blocker にしない。
 *   - OwnerMemo: 件数を summary で提示し operator 判断（移行設計が決まるまで blocker にすると将来の運用を縛る）。
 *   - PropertyOwner 重複: execute 時に source 側を破棄する想定で blocker にしない。
 */
export function checkOwnerMergeSafety(
  input: OwnerMergeSafetyInput,
): OwnerMergeSafetyResult {
  const reasons: OwnerMergeBlockReason[] = [];

  if (input.sameOwnerId) reasons.push("same_owner_id");
  if (!input.masterExists) reasons.push("master_not_found");
  if (!input.sourceExists) reasons.push("source_not_found");
  if (input.masterExists && input.masterIsArchived) reasons.push("master_archived");
  if (input.sourceExists && input.sourceIsArchived) reasons.push("source_archived");

  // source 側の手動編集情報を慎重に保護
  if (input.sourceChangeLogCount > 0) reasons.push("source_has_changelog");
  if (input.sourceHasNote) reasons.push("source_has_note");
  if (input.sourceHasExternalLinkKey) reasons.push("source_has_external_link_key");
  if (input.sourceVersion > 1) reasons.push("source_version_gt_1");

  // candidate API が出した duplicate ペアでも、preview 直前に再検証する。
  // master / source の正規化キーが揃わなければ別人の可能性 → blocker。
  //
  // ただし master または source が存在しない場合は key 比較自体が行われていない
  // ため、name_address_normalize_mismatch は出さない（master_not_found /
  // source_not_found と同時に出ると原因診断として誤解を招くため）。
  if (
    input.masterExists &&
    input.sourceExists &&
    !input.normalizeKeyMatches
  ) {
    reasons.push("name_address_normalize_mismatch");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true };
}
