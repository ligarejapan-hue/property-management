/**
 * 謄本自動取得 — 所在検索の入力組み立て（PR-2b-1・純関数）。
 *
 * Property の検索キー（補正後 address / lotNumber / buildingNumber）から所在検索の入力を作る。
 * 不動産番号があれば検索不要（番号での直接取得を優先）。所在が無ければ検索不能として安全に分類する。
 *
 * 方針:
 *  - 補正前値（originalAddress / originalLotNumber）は使わない（実投入が無く常に null のため）。
 *  - 所有者PII（名前・住所）は入力に含めない。ただし物件所在地・地番・家屋番号は秘匿情報として扱う
 *    （RegistrySearchRequest を log / AuditLog / error response に出さないのは呼び出し側の責務）。
 *  - 外部 I/O を一切しない純関数。
 */
import type { RegistrySearchRequest } from "./types";
import { isReadableChiban } from "./chiban-input";

/**
 * buildRegistrySearchRequest の入力（Property の検索キー部分集合・補正後の値のみ）。
 */
export interface RegistrySearchSource {
  /** 所在（住所・補正後 Property.address）。 */
  address: string | null;
  /** 地番（補正後 Property.lotNumber）。 */
  lotNumber: string | null;
  /** 家屋番号（Property.buildingNumber）。 */
  buildingNumber: string | null;
  /** 不動産番号（Property.realEstateNumber）。あれば検索不要。 */
  realEstateNumber: string | null;
  /** トレース用の非PII参照（例: 物件UUID）。所在地・PII は入れない。 */
  ref?: string | null;
}

/**
 * 所在検索が可能かの判別結果。
 *  - searchable:true  … request で所在検索できる
 *  - searchable:false … 検索しない（reason で理由を区別）
 *      has_real_estate_number … 不動産番号があるので番号取得を優先（検索不要）
 *      insufficient_location  … 所在が無く検索キーを満たさない（検索不能）
 */
export type BuildRegistrySearchResult =
  | { searchable: true; request: RegistrySearchRequest }
  | {
      searchable: false;
      reason:
        | "has_real_estate_number"
        | "insufficient_location"
        | "missing_identifier"
        | "malformed_identifier";
    };

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Property の検索キーから所在検索入力を組む純関数。
 *  1. realEstateNumber があれば検索不要（has_real_estate_number）
 *  2. address が無ければ検索不能（insufficient_location）
 *  3. 地番も家屋番号も無ければ検索不能（missing_identifier）
 *  4. 使う番号が読めない形なら検索不能（malformed_identifier）
 *  5. それ以外は所在検索可能（request を返す）
 * 補正前値は参照しない。
 *
 * ⚠ `ambiguous_type` は作らない。種別では止めない（発注者判断 2026-08-12）。
 */
export function buildRegistrySearchRequest(
  source: RegistrySearchSource,
): BuildRegistrySearchResult {
  const realEstateNumber = trimToNull(source.realEstateNumber);
  if (realEstateNumber) {
    return { searchable: false, reason: "has_real_estate_number" };
  }

  const address = trimToNull(source.address);
  if (!address) {
    return { searchable: false, reason: "insufficient_location" };
  }

  const lotNumber = trimToNull(source.lotNumber);
  const buildingNumber = trimToNull(source.buildingNumber);
  // ⚠使う番号は**家屋番号が優先**（= 建物の登記）。無ければ地番（= 土地の登記）。
  //   provider は「家屋番号が空でなければ建物」で判定するので、ここで決めた1つだけを
  //   渡して判定を一致させる（両方渡すと二重管理になる・設計 §3.1.2）。
  const effective = buildingNumber ?? lotNumber;
  if (!effective) {
    // ⚠番号なしで検索すると、その地番区域が丸ごと候補になり選びようがない。
    return { searchable: false, reason: "missing_identifier" };
  }
  if (!isReadableChiban(effective)) {
    // ⚠正規化すると別の筆を指す値（abc1x2 → 12）。一括は候補1件で自動購入するので通さない。
    //   ⚠優先された側で判定する。読めないからといって地番へ落とすと、
    //   利用者が意図しない土地の登記を買うことになる。
    return { searchable: false, reason: "malformed_identifier" };
  }

  return {
    searchable: true,
    request: {
      address,
      // ⚠決まった方だけを渡す。
      lotNumber: buildingNumber ? null : lotNumber,
      buildingNumber,
      ref: trimToNull(source.ref ?? null),
    },
  };
}
