/**
 * owner-contact-format.ts (DQ-02)
 *
 * Owner.zip / Owner.phone の品質判定・整形を行う純関数群（I/O なし）。
 * 既存 owner-name-quality.ts / corporate-number-cleanup.ts と同スタイルで、
 * 戻り値はコード/件数のみ（生値は route 側で maskValue 経由）。
 *
 * 設計（22B-dq-02-04-05-design.md DQ-02）:
 * - 郵便番号は既存 isValidPostalCode / formatPostalCode を再利用（重複実装しない）。
 * - 電話は新規。valid 判定は「桁数(10/11)＋先頭0」のみ。ハイフン位置・局番辞書には
 *   踏み込まない（地域可変＝誤検出源）。+81 / 内線付きは suspicious に倒す（自動変換しない）。
 */

import {
  isValidPostalCode,
  formatPostalCode,
} from "@/lib/address-lookup/normalize";

export type ZipClass = "valid" | "suspicious" | "empty";
export type PhoneClass = "valid" | "suspicious" | "empty" | "non_phone";
export type ContactField = "zip" | "phone";

// ---------------------------------------------------------------------------
// 郵便番号（既存関数へ委譲）
// ---------------------------------------------------------------------------

/** 郵便番号の品質分類。valid=7桁（既存 isValidPostalCode）/ empty / suspicious。 */
export function classifyZip(input: string | null | undefined): ZipClass {
  if (input == null) return "empty";
  const trimmed = input.trim();
  if (trimmed === "") return "empty";
  return isValidPostalCode(trimmed) ? "valid" : "suspicious";
}

// ---------------------------------------------------------------------------
// 電話番号（新規・純関数）
// ---------------------------------------------------------------------------

// 電話番号ラベル（TEL / 電話 / でんわ / phone）。NFKC 後に剥がす。
const PHONE_LABEL_RE = /tel|phone|電話|でんわ/gi;

/** NFKC 後に数字だけを抽出する（分類用）。 */
export function phoneDigits(input: string | null | undefined): string {
  if (!input) return "";
  return input.normalize("NFKC").replace(/[^0-9]/g, "");
}

/**
 * 電話番号の表記を正規化する（整形 apply 用）。
 * - 全角→半角（NFKC）・ラベル剥がし・区切り（括弧/空白/中黒/各種ハイフン等）を `-` に統一。
 * - **ハイフン位置は再構成しない**（局番境界は地域可変ゆえ、元の区切り位置を保つ）。
 * - 区切りの無い連続数字には `-` を挿入しない。
 */
export function normalizePhone(input: string | null | undefined): string {
  if (!input) return "";
  const nfkc = input.normalize("NFKC").replace(PHONE_LABEL_RE, "");
  return nfkc
    .replace(/[^0-9]+/g, "-") // 数字以外の連続を 1 つの区切りへ
    .replace(/^-+|-+$/g, ""); // 先頭末尾の区切りを除去
}

/**
 * 電話番号の品質分類。
 * - empty: null/空/空白のみ
 * - non_phone: 数字 0 桁（「不明」「電話なし」等）
 * - valid: 数字が 10 桁 or 11 桁 かつ先頭 0（固定/携帯/IP/フリーダイヤル）
 * - suspicious: 数字はあるが桁範囲外 / 先頭が 0 でない（+81・内線付き等）
 */
export function classifyPhone(input: string | null | undefined): PhoneClass {
  if (input == null) return "empty";
  if (input.trim() === "") return "empty";
  const digits = phoneDigits(input);
  if (digits.length === 0) return "non_phone";
  if ((digits.length === 10 || digits.length === 11) && digits.startsWith("0")) {
    return "valid";
  }
  return "suspicious";
}

// ---------------------------------------------------------------------------
// owner 単位の分類（監査レポート用）
// ---------------------------------------------------------------------------

export type OwnerContactIssueCode =
  | "zip_suspicious"
  | "zip_unformatted"
  | "phone_suspicious"
  | "phone_non_phone"
  | "phone_unnormalized";

export type ContactSeverity = "warning" | "info";

export interface OwnerContactInput {
  zip?: string | null;
  phone?: string | null;
}

export interface OwnerContactResult {
  issues: OwnerContactIssueCode[];
  severity: ContactSeverity | null;
}

const WARNING_ISSUES = new Set<OwnerContactIssueCode>([
  "zip_suspicious",
  "phone_suspicious",
  "phone_non_phone",
]);

/**
 * フィールド可視性ゲート（DQ-02 P1）。
 * 呼び出し側（route）で各 PII フィールドの生値が可視か（display-level が
 * full/edit/read）を渡す。`false` のフィールドは分類自体をスキップし、issue・
 * severity・summary に一切寄与させない。これにより、生値を見られないユーザーが
 * issue コード（zip_suspicious / phone_non_phone 等）から隠し値の品質を推測する
 * オラクルを塞ぐ（既存 corporate_number 重複検出のゲートと同方針）。
 * 省略時は両方 true（純関数テスト・後方互換）。
 */
export interface OwnerContactVisibility {
  zip?: boolean;
  phone?: boolean;
}

/**
 * Owner の zip / phone をまとめて分類する。
 * empty（欠損）は「形式エラーではない」ため issue にしない。
 * `visibility` で不可視指定されたフィールドは分類しない（P1 オラクル防止）。
 */
export function classifyOwnerContact(
  input: OwnerContactInput,
  visibility?: OwnerContactVisibility,
): OwnerContactResult {
  const zipVisible = visibility?.zip ?? true;
  const phoneVisible = visibility?.phone ?? true;
  const issues: OwnerContactIssueCode[] = [];

  if (zipVisible) {
    const zip = input.zip;
    const zc = classifyZip(zip);
    if (zc === "suspicious") {
      issues.push("zip_suspicious");
    } else if (zc === "valid" && zip != null && formatPostalCode(zip) !== zip) {
      issues.push("zip_unformatted");
    }
  }

  if (phoneVisible) {
    const phone = input.phone;
    const pc = classifyPhone(phone);
    if (pc === "suspicious") {
      issues.push("phone_suspicious");
    } else if (pc === "non_phone") {
      issues.push("phone_non_phone");
    } else if (
      pc === "valid" &&
      phone != null &&
      normalizePhone(phone) !== phone
    ) {
      issues.push("phone_unnormalized");
    }
  }

  let severity: ContactSeverity | null = null;
  if (issues.some((i) => WARNING_ISSUES.has(i))) severity = "warning";
  else if (issues.length > 0) severity = "info";

  return { issues, severity };
}

// ---------------------------------------------------------------------------
// preview: 整形 apply 可否（corporate-cleanup / name-fix と同型）
// ---------------------------------------------------------------------------

export type ContactFixAction = "none" | "format" | "manual";
export type ContactFixManualReason = "suspicious" | "non_phone" | "empty" | null;

export interface ContactFixProposal {
  field: ContactField;
  action: ContactFixAction;
  manualReason: ContactFixManualReason;
  /** format 時の整形後の値（route 側でマスク）。それ以外は null。 */
  cleanedValue: string | null;
  changedFields: ContactField[];
}

/** 郵便番号の整形可否。valid だが未整形のときのみ format（123-4567 へ）。 */
export function decideZipFix(zip: string | null | undefined): ContactFixProposal {
  const base: ContactFixProposal = {
    field: "zip",
    action: "none",
    manualReason: null,
    cleanedValue: null,
    changedFields: [],
  };
  const c = classifyZip(zip);
  if (c === "empty") return { ...base, action: "manual", manualReason: "empty" };
  if (c === "suspicious")
    return { ...base, action: "manual", manualReason: "suspicious" };
  // valid
  const formatted = formatPostalCode(zip as string);
  if (formatted !== zip) {
    return { ...base, action: "format", cleanedValue: formatted, changedFields: ["zip"] };
  }
  return base;
}

/** 電話番号の整形可否。valid だが未正規化のときのみ format。 */
export function decidePhoneFix(
  phone: string | null | undefined,
): ContactFixProposal {
  const base: ContactFixProposal = {
    field: "phone",
    action: "none",
    manualReason: null,
    cleanedValue: null,
    changedFields: [],
  };
  const c = classifyPhone(phone);
  if (c === "empty") return { ...base, action: "manual", manualReason: "empty" };
  if (c === "non_phone")
    return { ...base, action: "manual", manualReason: "non_phone" };
  if (c === "suspicious")
    return { ...base, action: "manual", manualReason: "suspicious" };
  // valid
  const normalized = normalizePhone(phone);
  if (normalized !== phone) {
    return { ...base, action: "format", cleanedValue: normalized, changedFields: ["phone"] };
  }
  return base;
}

// ---------------------------------------------------------------------------
// apply safety（enum コードのみ。name-fix safety と同型）
// ---------------------------------------------------------------------------

export type ContactFixBlockReason =
  | "owner_archived"
  | "version_mismatch"
  | "no_change"
  | "forbidden_value";

export interface ContactFixSafetyInput {
  field: ContactField;
  isArchived: boolean;
  versionMatches: boolean;
  currentValue: string | null;
  /** null / "" = クリア（ゴミ削除）として許可。 */
  newValue: string | null;
}

export type ContactFixSafetyResult =
  | { ok: true; newValue: string | null }
  | { ok: false; reasons: ContactFixBlockReason[] };

/**
 * 連絡先補正の安全条件チェック。空へのクリアは許可、非空の新値はその field として
 * valid でなければ forbidden_value（apply は品質を必ず改善する方向に限定）。
 */
export function checkContactFixSafety(
  input: ContactFixSafetyInput,
): ContactFixSafetyResult {
  const reasons: ContactFixBlockReason[] = [];
  const cur = input.currentValue ?? "";
  const nv = input.newValue ?? "";

  if (input.isArchived) reasons.push("owner_archived");
  if (!input.versionMatches) reasons.push("version_mismatch");
  if (cur === nv) reasons.push("no_change");

  if (nv.trim() !== "") {
    const ok =
      input.field === "zip"
        ? isValidPostalCode(nv)
        : classifyPhone(nv) === "valid";
    if (!ok) reasons.push("forbidden_value");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, newValue: input.newValue };
}

// ---------------------------------------------------------------------------
// summary 集計（route の dry-run サマリ用）
// ---------------------------------------------------------------------------

export interface OwnerContactSummary {
  zipSuspicious: number;
  zipUnformatted: number;
  phoneSuspicious: number;
  phoneNonPhone: number;
  phoneUnnormalized: number;
  totalCandidates: number;
}

export function emptyOwnerContactSummary(): OwnerContactSummary {
  return {
    zipSuspicious: 0,
    zipUnformatted: 0,
    phoneSuspicious: 0,
    phoneNonPhone: 0,
    phoneUnnormalized: 0,
    totalCandidates: 0,
  };
}

const ISSUE_TO_SUMMARY: Record<
  OwnerContactIssueCode,
  keyof OwnerContactSummary
> = {
  zip_suspicious: "zipSuspicious",
  zip_unformatted: "zipUnformatted",
  phone_suspicious: "phoneSuspicious",
  phone_non_phone: "phoneNonPhone",
  phone_unnormalized: "phoneUnnormalized",
};

/** result に 1 つでも issue があれば種別ごとに加算し totalCandidates を 1 増やす。 */
export function tallyOwnerContact(
  summary: OwnerContactSummary,
  result: OwnerContactResult,
): void {
  if (result.issues.length === 0) return;
  for (const issue of result.issues) summary[ISSUE_TO_SUMMARY[issue]]++;
  summary.totalCandidates++;
}
