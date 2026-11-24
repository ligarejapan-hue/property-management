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
 *   - 2026-11-24: 法人のペア（法人番号・法人名で一致）だけ、ChangeLog / version>1 では
 *     止めない（項目は統合で master へ引き継ぎ、違う値は master の変更履歴に残す）。
 */

import {
  handoverWrites,
  isCurrentAddressOnlyChangeLog,
  type CurrentAddressHandover,
} from "@/lib/owner-merge-current-address";

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
  // 同じ所有者と確かめられない（氏名住所・法人番号・法人名のどれでも一致しない＝別人の可能性）。
  // 旧コード name_address_normalize_mismatch（氏名住所だけで見ていた頃）の後継（2026-11-24）。
  | "owner_identity_mismatch"
  | "corporate_number_conflict"      // 両方に法人番号があって違う（別の法人）
  | "company_registry_number_conflict" // 両方に会社法人等番号（12桁）があって違う（別の法人）
  | "current_address_conflict"      // 現住所が食い違う（どちらが新しいか決められない）
  | "current_zip_conflict"           // 同じ現住所なのに郵便番号が食い違う
  | "version_mismatch";              // execute 時: client 送信 version と DB version が一致しない

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
   * 現住所の引き継ぎ結果（設計 §7）。
   *
   * ⚠これが無いと門が働かない: 現住所は通常の編集や補正で後から入るため、
   * 現住所を持つ source は必ず変更履歴が付き version も上がる。
   * 「履歴があれば拒否」のままでは**引き継ぎ処理が一度も動かない**。
   */
  currentAddressHandover?: CurrentAddressHandover;
  /**
   * source の変更履歴に出てくる項目名（重複可）。
   * 現住所の2列だけなら、引き継ぎで値が残るので統合を許す。
   */
  sourceChangeLogFields?: readonly string[];
  /**
   * master と source が同じ所有者と言えるか（resolveOwnerMergeMatch の matchedBy !== null）。
   * 氏名住所・法人番号・法人名のどれかで一致すれば true。
   * candidate API が出した duplicate グループは原則一致するはずだが、
   * 個別ペアで execute 直前に再検証する。一致しない場合は別人の可能性。
   */
  normalizeKeyMatches: boolean;
  /**
   * 法人のペア（法人番号か法人名の経路で同じと言える・resolveOwnerMergeMatch）。
   * true のときだけ source の変更履歴・version>1 で止めない（2026-11-24 発注者承認）。
   * 法人は住所・電話の直しが入りやすく、門のままだと法人の重複がほぼ統合できないため。
   * ⚠備考・外部リンクキーは法人でも止める（消える情報を引き継ぐ先が無い）。
   */
  corporatePair?: boolean;
  /** 両方の法人番号が違う（resolveOwnerMergeMatch の corporateNumberConflict）。 */
  corporateNumberConflict?: boolean;
  /** 両方の会社法人等番号が違う（resolveOwnerMergeMatch の companyRegistryNumberConflict）。 */
  companyRegistryNumberConflict?: boolean;
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

  const handover = input.currentAddressHandover ?? { kind: "none" as const };

  // ⚠現住所が食い違う組み合わせは統合させない（設計 §7）。
  //   通せば source が手で入れた現住所が archive とともに失われる。
  if (handover.kind === "conflict_address") {
    reasons.push("current_address_conflict");
  }
  if (handover.kind === "conflict_zip") {
    reasons.push("current_zip_conflict");
  }

  // 変更が「現住所の2列だけ」で、かつ引き継ぎで実際に値が残るときだけ、
  // 履歴・version の門を緩める。それ以外は従来どおり拒否（緩めない）。
  const relaxForCurrentAddress =
    handoverWrites(handover) &&
    isCurrentAddressOnlyChangeLog(input.sourceChangeLogFields ?? []);
  // 法人のペアは履歴・version の門を緩める（項目は統合側で master へ引き継ぐ・記録に残す）。
  const relaxHistory = relaxForCurrentAddress || input.corporatePair === true;

  // source 側の手動編集情報を慎重に保護
  if (input.sourceChangeLogCount > 0 && !relaxHistory)
    reasons.push("source_has_changelog");
  if (input.sourceHasNote) reasons.push("source_has_note");
  if (input.sourceHasExternalLinkKey) reasons.push("source_has_external_link_key");
  if (input.sourceVersion > 1 && !relaxHistory)
    reasons.push("source_version_gt_1");

  // candidate API が出した duplicate ペアでも、preview 直前に再検証する。
  // 同じ所有者と言えなければ別人の可能性 → blocker。
  //
  // ただし master または source が存在しない場合は比較自体が行われていない
  // ため、owner_identity_mismatch は出さない（master_not_found /
  // source_not_found と同時に出ると原因診断として誤解を招くため）。
  // 法人番号の食い違いは、それ自体が理由なので重ねて出さない。
  if (input.masterExists && input.sourceExists) {
    if (input.corporateNumberConflict) {
      reasons.push("corporate_number_conflict");
    } else if (input.companyRegistryNumberConflict) {
      reasons.push("company_registry_number_conflict");
    } else if (!input.normalizeKeyMatches) {
      reasons.push("owner_identity_mismatch");
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true };
}
