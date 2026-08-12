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
import { normalizeName, normalizeAddress } from "./normalize";
import { normalizeCorporateNumber } from "./corporate-number";

// ---------------------------------------------------------------------------
// Phase 2-B: Owner.address「実質空欄」判定 helper
// ---------------------------------------------------------------------------
//
// 既存の判定 (`addr == null || addr.trim().length === 0` 系) を 1 箇所に集約する。
// String.prototype.trim() は ECMAScript 仕様で全角空白 　・タブ・改行・
// 各種制御文字を除去対象に含むため、追加の正規化は不要。
//
// 用途:
//   - correction-candidates の address_null タブ判定
//   - address-fill の補完可否判定 (race-safe な current.address exact match と併用)
//   - archive の addressMissing フラグ
// 戻り値は boolean のみで Owner PII は含まない。
export function isOwnerAddressEffectivelyEmpty(
  addr: string | null | undefined,
): boolean {
  if (addr == null) return true;
  return addr.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Phase 2-B: 重複候補グルーピングキー（correction-candidates と merge-preview で共有）
// ---------------------------------------------------------------------------
//
// candidate key の役割:
//   - correction-candidates API が duplicate グループを検出するキー
//   - merge-preview API が master / source のキー一致を再検証するキー
//
// 仕様:
//   - address あり → `normalizeName(name) + "|||" + normalizeAddress(address)`
//   - address なし → `normalizeName(name) + "|||" + "__noaddr__" + zip + "__" + phone`
//     （いずれも空文字許容のフォールバック。既存仕様）
//
// PII について:
//   - キー文字列自体は normalize 済みではあるが、元の name/address/zip/phone を
//     部分的に復元可能。**API レスポンスや AuditLog には絶対に出さない。**
//   - クライアントには別途 opaque な duplicateGroupId（例: dup-1）を割り当てる。
//
// 既存仕様を勝手に広げない:
//   - 「addressなしで zip も phone も両方無い」owner も "__noaddr____" でキー化される
//     が、これは複数 owner で衝突する可能性があるため candidate API 側のグルーピング
//     対象に含まれる（既存仕様どおり）。
export interface OwnerDuplicateCandidateKeyInput {
  name: string;
  address: string | null;
  zip: string | null;
  phone: string | null;
}

export function buildOwnerDuplicateCandidateKey(
  input: OwnerDuplicateCandidateKeyInput,
): string {
  const n = normalizeName(input.name);
  const a = input.address
    ? normalizeAddress(input.address)
    : `__noaddr__${input.zip ?? ""}__${input.phone ?? ""}`;
  return `${n}|||${a}`;
}

// ---------------------------------------------------------------------------
// Phase 2-A: corporateNumber / externalLinkKey による重複検出キー
// ---------------------------------------------------------------------------
//
// name_address ベースの buildOwnerDuplicateCandidateKey とは独立した追加キー。
// correction-candidates API は 3 系統（name_address / corporate_number /
// external_link_key）で並行に重複グループ化を行い、各グループに opaque な
// duplicateGroupId を割り当てる（dup-N / dup-cn-N / dup-elk-N）。
//
// PII について（重要）:
//   - 返却される key 文字列は **法人番号生値 / externalLinkKey 生値そのもの**。
//   - **API レスポンス / AuditLog detail には絶対に含めない**（opaque ID 経由で
//     のみクライアントに渡す）。
//
// 既存 buildOwnerDuplicateCandidateKey は無改変。

/**
 * Owner.corporateNumber から「重複検出に使えるキー」を返す。
 *
 * Codex P2 (round 3): プロジェクト共通の canonical normalizer
 * `normalizeCorporateNumber` を再利用する。これにより:
 *   - 全角数字（０-９）→ 半角数字に正規化される
 *   - 各種ハイフン類（- ‐ ‑ ‒ – — ― ー － − ─ など）と空白を除去する
 *   - 上記正規化後 13 桁の数字のみなら採用、それ以外は null
 * 旧実装の `replace(/\D/g, "")` だと英字混在を誤って採用したり、
 * 全角数字を取り逃したりして他の corporate-number 機能と整合しなかった。
 *
 * 戻り値はそのまま **重複グルーピングの Map key** として使うが、
 * **API レスポンス / AuditLog / URL には絶対に出さない**（opaque ID 経由のみ）。
 */
export function buildOwnerCorporateNumberDuplicateKey(
  corporateNumber: string | null | undefined,
): string | null {
  return normalizeCorporateNumber(corporateNumber);
}

/**
 * Owner.externalLinkKey から「重複検出に使えるキー」を返す。
 *
 * - null / undefined → null
 * - trim 後の空文字 → null
 * - 上記以外 → trim 後の文字列をキーとする
 *
 * externalLinkKey は外部システム由来の任意文字列のため、normalize は行わず
 * trim のみ（大小区別・全半角区別を含めて完全一致を要求する）。
 */
export function buildOwnerExternalLinkKeyDuplicateKey(
  externalLinkKey: string | null | undefined,
): string | null {
  if (externalLinkKey == null) return null;
  const trimmed = externalLinkKey.trim();
  if (trimmed === "") return null;
  return trimmed;
}

// rawData の住所フィールド候補（直接値として使えるキー名）。
// owner-csv ルートの OWNER_CSV_COLUMN_MAP と整合させた優先順序。
// ⚠この経路が埋めるのは**登記上の住所**なので、現住所系のキーは候補にしない。
//   現住所を登記上の欄へ入れると、登記上の住所が失われて名寄せと物件の紐づけが汚れる
//   （設計 §7・復元できない）。
const DIRECT_ADDRESS_KEYS_PRIMARY = [
  "住所",
  "所在地",
  "address",
  "ownerAddress",
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
  // Phase 2-B: 全角空白などを含めた「実質空欄」判定を helper に統一
  if (!isOwnerAddressEffectivelyEmpty(input.currentAddress)) {
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

// ---------------------------------------------------------------------------
// Phase 2-A: Owner archive (soft-delete) safety check
// ---------------------------------------------------------------------------

export type OwnerArchiveBlockReason =
  | "owner_archived"          // 既に isArchived=true
  | "version_mismatch"         // optimistic lock 失敗
  | "property_owner_exists"   // PropertyOwner.count > 0
  | "note_exists"              // Owner.note あり
  | "external_link_key_exists" // externalLinkKey あり
  | "import_source_unsafe"    // ImportJobRow が無い / 複数 / status != success
  | "not_delete_candidate"    // それ以外の理由で delete_candidate 相当でない（changelog 等）
  | "address_missing"         // address が未入力（address-fill 対象を archive で消さない）
  | "owner_memo_exists";      // OwnerMemo が 1件以上ある（メモ履歴がある owner を archive で隠さない）

export interface OwnerArchiveSafetyInput {
  /** Owner 現状（DB から取得後の値）。 */
  isArchived: boolean;
  /** クライアント送信 version と DB version の一致確認用。一致なら true。 */
  versionMatches: boolean;
  /** Owner に紐づく PropertyOwner 件数。 */
  propertyOwnerCount: number;
  /** owners テーブルへの ChangeLog 件数（targetTable="owners"）。 */
  changeLogCount: number;
  /** Owner.note が非空なら true。 */
  hasNote: boolean;
  /** Owner.externalLinkKey が非空なら true。 */
  hasExternalLinkKey: boolean;
  /** Owner.version 値（>1 なら手動編集履歴があるため not_delete_candidate 扱い）。 */
  version: number;
  /** owner_csv ImportJobRow 件数（createdId=ownerId）。 */
  importRowCount: number;
  /** importRowCount===1 のときの status が "success" か。 */
  importRowSuccess: boolean;
  /**
   * address が null / "" / 空白のみなら true。
   * correction-candidates の delete_candidate 条件 (!isAddressNull) と整合させる。
   * address-fill 対象の owner を archive で消さない。
   */
  addressMissing: boolean;
  /**
   * OwnerMemo の件数。1以上で archive を拒否する。
   * OwnerMemo は owner.version も ChangeLog も上げないため、ここで明示的に守る。
   */
  ownerMemoCount: number;
}

export type OwnerArchiveSafetyResult =
  | { ok: true }
  | { ok: false; reasons: OwnerArchiveBlockReason[] };

/**
 * Owner archive (soft-delete) の安全条件チェック。
 *
 * correction-candidates の recommendedAction === "delete_candidate" と
 * 同等の条件を強制する（追加で version / archive 状態を見る）。
 *
 * 複数違反は全件返す（UI が一括表示できるように）。
 * 値（PII）は含めず enum コードのみ返す。
 */
export function checkOwnerArchiveSafety(
  input: OwnerArchiveSafetyInput,
): OwnerArchiveSafetyResult {
  const reasons: OwnerArchiveBlockReason[] = [];

  if (input.isArchived) reasons.push("owner_archived");
  if (!input.versionMatches) reasons.push("version_mismatch");
  if (input.propertyOwnerCount > 0) reasons.push("property_owner_exists");
  if (input.hasNote) reasons.push("note_exists");
  if (input.hasExternalLinkKey) reasons.push("external_link_key_exists");
  if (input.addressMissing) reasons.push("address_missing");
  if (input.ownerMemoCount > 0) reasons.push("owner_memo_exists");

  // candidate 側で version_gt_1 / changelog_exists は hold 扱い → not_delete_candidate に集約
  if (input.changeLogCount > 0 || input.version > 1) {
    reasons.push("not_delete_candidate");
  }

  // ImportJobRow 由来の安全条件
  if (
    input.importRowCount !== 1 ||
    (input.importRowCount === 1 && !input.importRowSuccess)
  ) {
    reasons.push("import_source_unsafe");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true };
}
