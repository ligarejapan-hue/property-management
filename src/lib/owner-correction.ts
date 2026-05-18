/**
 * owner-correction.ts
 *
 * Phase 1: address_null Owner への住所補完に関するヘルパー。
 * - rawData からの住所抽出
 * - 住所補完の安全条件チェック（address_null 専用）
 */

// rawData の住所フィールド候補（直接値として使えるキー名）。
// owner-csv ルートの OWNER_CSV_COLUMN_MAP と整合させた優先順序。
const DIRECT_ADDRESS_KEYS_PRIMARY = [
  "住所",
  "所在地",
  "address",
  "ownerAddress",
  "currentAddress",
  "現住所",
];

// 「所有者住所」は reception-owner フローでは結合フィールドの一部として使われる。
// 都道府県・所有者市区郡 が rawData に存在するときは結合形式を優先し、
// 存在しない場合のみ単独フィールドとして扱う（フォールバック）。
const DIRECT_ADDRESS_KEYS_FALLBACK = ["所有者住所"];

// 結合型住所を組み立てるフィールド群（reception-owner フローのパターン）。
const COMPOSITE_ADDRESS_KEYS = ["都道府県", "所有者市区郡", "所有者住所", "建物名"];

// 結合フォームの存在を示すキー（このいずれかが有効なら結合形式を試みる）。
const COMPOSITE_INDICATOR_KEYS = ["都道府県", "所有者市区郡"];

/** rawData の値が有効な住所文字列かを判定する。 */
function isValidAddressValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (t.length === 0) return false;
  if (t === "null" || t === "undefined") return false;
  return true;
}

export interface ExtractAddressResult {
  address: string;
  /** rawData で実際に使用したキー名（AuditLog の sourceFieldNames 用）。 */
  sourceFieldNames: string[];
}

/**
 * ImportJobRow.rawData から住所を抽出する。
 * 直接フィールド → 結合フィールドの順に試みる。
 * 有効な住所が見つからなければ null を返す。
 */
export function extractAddressFromRawData(
  rawData: Record<string, unknown> | null | undefined,
): ExtractAddressResult | null {
  if (!rawData) return null;

  // 1. 単一フィールド（主要キー）を順に試みる
  for (const key of DIRECT_ADDRESS_KEYS_PRIMARY) {
    const v = rawData[key];
    if (isValidAddressValue(v)) {
      return { address: v.trim(), sourceFieldNames: [key] };
    }
  }

  // 2. 結合フィールド（都道府県 + 所有者市区郡 + 所有者住所 + 建物名）。
  //    reception-owner フローのパターン。
  //    COMPOSITE_INDICATOR_KEYS のいずれかが有効なときのみ試みる。
  const hasCompositeIndicator = COMPOSITE_INDICATOR_KEYS.some((k) =>
    isValidAddressValue(rawData[k]),
  );
  if (hasCompositeIndicator) {
    const parts = COMPOSITE_ADDRESS_KEYS.map((k) => {
      const v = rawData[k];
      return isValidAddressValue(v) ? v.trim() : "";
    }).filter((p) => p.length > 0);

    if (parts.length > 0) {
      const usedKeys = COMPOSITE_ADDRESS_KEYS.filter((k) =>
        isValidAddressValue(rawData[k]),
      );
      return { address: parts.join(""), sourceFieldNames: usedKeys };
    }
  }

  // 3. 「所有者住所」を単独フィールドとして試みる（フォールバック）。
  //    結合フォームが存在しない場合のみ到達する。
  for (const key of DIRECT_ADDRESS_KEYS_FALLBACK) {
    const v = rawData[key];
    if (isValidAddressValue(v)) {
      return { address: v.trim(), sourceFieldNames: [key] };
    }
  }

  return null;
}

export interface AddressFillSafetyCheckInput {
  /** Owner の現在の住所（null または空文字なら補完対象）。 */
  currentAddress: string | null | undefined;
  /**
   * ownerId に紐づく owner_csv ImportJobRow の件数。
   * - 0   → import_source_unknown
   * - 1   → 唯一に特定できた → status を確認
   * - 2以上 → import_source_ambiguous（複数候補から勝手に選ばない）
   */
  importRowCount: number;
  /** ImportJobRow.status が "success" か（importRowCount === 1 の場合のみ参照）。 */
  importRowSuccess: boolean;
  /** address フィールドの既存 ChangeLog が存在するか。 */
  addressChangeLogExists: boolean;
  /** rawData から抽出した住所候補（null なら抽出失敗）。 */
  extractedAddress: string | null;
}

export type AddressFillSafetyResult =
  | { ok: true; address: string }
  | { ok: false; reason: AddressFillBlockReason };

export type AddressFillBlockReason =
  | "address_already_set"        // すでに住所が入っている（上書き防止）
  | "import_source_unknown"      // ImportJobRow が 0件
  | "import_source_ambiguous"    // ImportJobRow が 2件以上（一意に特定できない）
  | "import_row_not_success"     // ImportJobRow.status !== "success"
  | "address_changelog_exists"   // address フィールドの ChangeLog あり（手動編集済み）
  | "no_address_in_rawdata";     // rawData から住所を抽出できなかった

/**
 * 住所補完が安全に実行できるかを判定する。
 *
 * - ImportJobRow は ownerId から一意（1件）に特定できることが必須条件。
 *   0件 → import_source_unknown、2件以上 → import_source_ambiguous で拒否。
 * - property_owner_exists（物件紐づきあり）は Phase 1 ではブロック理由にしない。
 * - version_gt_1 / changelog_exists（address 以外）も許容する。
 * - address フィールドの ChangeLog が存在する場合のみ拒否する。
 */
export function checkAddressFillSafety(
  input: AddressFillSafetyCheckInput,
): AddressFillSafetyResult {
  const addr = input.currentAddress;
  if (addr !== null && addr !== undefined && addr.trim().length > 0) {
    return { ok: false, reason: "address_already_set" };
  }
  if (input.importRowCount === 0) {
    return { ok: false, reason: "import_source_unknown" };
  }
  if (input.importRowCount > 1) {
    return { ok: false, reason: "import_source_ambiguous" };
  }
  // importRowCount === 1 ここから
  if (!input.importRowSuccess) {
    return { ok: false, reason: "import_row_not_success" };
  }
  if (input.addressChangeLogExists) {
    return { ok: false, reason: "address_changelog_exists" };
  }
  if (!input.extractedAddress) {
    return { ok: false, reason: "no_address_in_rawdata" };
  }
  return { ok: true, address: input.extractedAddress };
}
