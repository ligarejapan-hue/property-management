/**
 * owner-correction.ts
 *
 * Phase 1: address_null Owner への住所補完に関するヘルパー。
 * - rawData からの住所抽出
 * - 住所補完の安全条件チェック（address_null 専用）
 * - 受付帳×所有者 ImportJobRow からの owner entry 解決（reception-owner source）
 */
import {
  type RecoveredOwner,
  RECEPTION_OWNER_LINK_DATA_KEY,
} from "./reception-owner-link";
import { normalizeName } from "./normalize";

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
  /**
   * 受付帳×所有者 row が一意だが、内部の owner link entry が複数一致した場合 true。
   * importRowCount === 1 かつこのフラグが true の場合は reception_owner_source_ambiguous。
   * 省略時は false 扱い。
   */
  receptionOwnerEntryAmbiguous?: boolean;
}

export type AddressFillSafetyResult =
  | { ok: true; address: string }
  | { ok: false; reason: AddressFillBlockReason };

export type AddressFillBlockReason =
  | "address_already_set"              // すでに住所が入っている（上書き防止）
  | "import_source_unknown"            // ImportJobRow が 0件
  | "import_source_ambiguous"          // ImportJobRow が 2件以上（一意に特定できない）
  | "import_row_not_success"           // ImportJobRow.status !== "success"
  | "address_changelog_exists"         // address フィールドの ChangeLog あり（手動編集済み）
  | "no_address_in_rawdata"            // rawData から住所を抽出できなかった
  | "reception_owner_source_ambiguous"; // reception-owner row の owner entry が複数一致

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
  // reception-owner row が一意でも owner link entry が複数一致した場合
  if (input.receptionOwnerEntryAmbiguous) {
    return { ok: false, reason: "reception_owner_source_ambiguous" };
  }
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

// ---------------------------------------------------------------------------
// Reception-owner source helpers
// ---------------------------------------------------------------------------

/**
 * 受付帳×所有者 ImportJobRow の __owner_link_data から、対象 Owner に対応する
 * RecoveredOwner エントリを一意に特定する。
 *
 * マッチング方針:
 *   1. normalizeName で氏名を正規化して完全一致する entry を抽出
 *   2. 複数一致かつ ownerZip が双方に存在する場合、zip で絞り込みを試みる
 *   3. 最終的に 0件 → no_address_in_rawdata / 複数 → reception_owner_source_ambiguous
 *   4. entry.address が空の場合も no_address_in_rawdata
 *
 * ownerName が null/空の場合はマッチング不能として no_address_in_rawdata を返す。
 */
export function resolveReceptionOwnerEntry(
  entries: RecoveredOwner[],
  ownerName: string | null | undefined,
  ownerZip: string | null | undefined,
): { ok: true; entry: RecoveredOwner } | { ok: false; reason: "reception_owner_source_ambiguous" | "no_address_in_rawdata" } {
  const targetName = normalizeName(ownerName ?? "");
  if (!targetName) {
    return { ok: false, reason: "no_address_in_rawdata" };
  }

  const nameMatches = entries.filter(
    (e) => normalizeName(e.name) === targetName,
  );

  if (nameMatches.length === 0) {
    return { ok: false, reason: "no_address_in_rawdata" };
  }

  if (nameMatches.length > 1) {
    // zip で絞り込みを試みる（両方に zip がある場合のみ）
    const targetZip = ownerZip ? ownerZip.trim() : null;
    if (targetZip) {
      const zipMatches = nameMatches.filter(
        (e) => e.zip && e.zip.trim() === targetZip,
      );
      if (zipMatches.length === 1) {
        const entry = zipMatches[0];
        if (!entry.address) return { ok: false, reason: "no_address_in_rawdata" };
        return { ok: true, entry };
      }
    }
    return { ok: false, reason: "reception_owner_source_ambiguous" };
  }

  // name match が 1件
  const entry = nameMatches[0];
  if (!entry.address) return { ok: false, reason: "no_address_in_rawdata" };
  return { ok: true, entry };
}

/**
 * RecoveredOwner エントリから住所抽出結果を生成する。
 * sourceFieldNames は値を含まないフィールドパス名のみにする（AuditLog PII 要件）。
 */
export function extractAddressFromRecoveredOwner(
  entry: RecoveredOwner,
): ExtractAddressResult | null {
  if (!entry.address || entry.address.trim() === "") return null;
  return {
    address: entry.address.trim(),
    sourceFieldNames: [`${RECEPTION_OWNER_LINK_DATA_KEY}.address`],
  };
}
