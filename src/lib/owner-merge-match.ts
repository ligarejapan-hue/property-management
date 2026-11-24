/**
 * 統合するペア（master / source）が「同じ所有者」と言えるかを決める（2026-11-24 発注者承認）。
 *
 * 重複候補の一覧（correction-candidates）が組むグループと、統合のプレビュー・実行
 * （merge-preview / merge）の再確認は**この1か所**で決める。一覧で統合できそうに見えて
 * 実行で止まる、の食い違いを作らないため。
 *
 * ## 同じ所有者と言える経路（上から順に採用）
 * | 経路 | 条件 | 対象 |
 * |---|---|---|
 * | name_address | 氏名＋住所をそろえた値が同じ（従来） | 個人・法人 |
 * | corporate_number | 13桁にそろえた法人番号が同じ | 法人番号を見られる人だけ |
 * | corporate_name | 両方とも法人格の語を含み、法人名をそろえた値が同じ（住所は問わない） | 法人 |
 *
 * ⚠両方に法人番号があって違うなら、名前や住所が同じでも**別の法人**として止める。
 * ⚠法人番号を見られない人（owner_corporate_number が full でない）には法人番号の経路を
 *   使わず、食い違いも「同じ所有者と確かめられない」としか伝えない
 *   （一覧の法人番号一致を full だけに出しているのと同じ理由: 番号が同じ/違うの1bitを渡さない）。
 *
 * 純関数・PII を返さない（経路の enum と boolean のみ）。
 */
import {
  buildOwnerDuplicateCandidateKey,
  buildOwnerCorporateNameDuplicateKey,
  buildOwnerCorporateNumberDuplicateKey,
} from "@/lib/owner-correction";

export type OwnerMergeMatchKind =
  | "name_address"
  | "corporate_number"
  | "corporate_name";

export interface OwnerMergeIdentity {
  name: string;
  address: string | null;
  zip: string | null;
  phone: string | null;
  corporateNumber: string | null;
}

export interface OwnerMergeMatch {
  /** 採用した経路。どれにも当たらなければ null（＝統合させない）。 */
  matchedBy: OwnerMergeMatchKind | null;
  /**
   * 法人のペアとして扱うか（法人番号か法人名の経路で同じと言える）。
   * true のときだけ、source の変更履歴・version による門を緩め、項目を引き継ぐ。
   */
  corporatePair: boolean;
  /** 両方の法人番号が違う（見られる人にだけ true を返す）。 */
  corporateNumberConflict: boolean;
}

export function resolveOwnerMergeMatch(
  master: OwnerMergeIdentity,
  source: OwnerMergeIdentity,
  options: { corporateNumberAvailable: boolean },
): OwnerMergeMatch {
  const cnMaster = buildOwnerCorporateNumberDuplicateKey(master.corporateNumber);
  const cnSource = buildOwnerCorporateNumberDuplicateKey(source.corporateNumber);
  if (cnMaster !== null && cnSource !== null && cnMaster !== cnSource) {
    return {
      matchedBy: null,
      corporatePair: false,
      corporateNumberConflict: options.corporateNumberAvailable,
    };
  }

  const nameAddress =
    buildOwnerDuplicateCandidateKey(master) ===
    buildOwnerDuplicateCandidateKey(source);
  const corporateNumber =
    options.corporateNumberAvailable &&
    cnMaster !== null &&
    cnMaster === cnSource;
  const nameKeyMaster = buildOwnerCorporateNameDuplicateKey(master.name);
  const corporateName =
    nameKeyMaster !== null &&
    nameKeyMaster === buildOwnerCorporateNameDuplicateKey(source.name);

  const matchedBy: OwnerMergeMatchKind | null = nameAddress
    ? "name_address"
    : corporateNumber
      ? "corporate_number"
      : corporateName
        ? "corporate_name"
        : null;
  return {
    matchedBy,
    corporatePair: corporateNumber || corporateName,
    corporateNumberConflict: false,
  };
}
