/**
 * owner-quality-audit-ui.ts (DQ-01/DQ-02 owner 品質監査 UI 用の純ヘルパ)
 *
 * admin/owners/quality-audit ページが消費する既存 backend:
 *   - DQ-01: GET name-quality-candidates / POST [id]/correction/name-fix
 *   - DQ-02: GET contact-quality-candidates / POST [id]/correction/contact-fix
 * ページ本体（client component）は node 環境の vitest では描画テストできないため、
 * テスト可能な純ロジック（ラベル / フィルタ種別 / 整形対象フィールド導出 / 監査表示用
 * エスケープ）をここに切り出してユニットテストする（既存の「純関数 + test」方針に倣う）。
 *
 * I/O なし・React 非依存。
 */
import type {
  OwnerNameIssueCode,
  OwnerNameKanaIssueCode,
  OwnerNameQualitySummary,
} from "./owner-name-quality";
import type {
  OwnerContactIssueCode,
  OwnerContactSummary,
} from "./owner-contact-format";

export type NameFilterType = "all" | OwnerNameIssueCode | OwnerNameKanaIssueCode;
export type ContactFilterType = "all" | OwnerContactIssueCode;
export type ContactField = "zip" | "phone";

// ---------------------------------------------------------------------------
// 表示ラベル（issue コード → 日本語）。
// ---------------------------------------------------------------------------

export const NAME_ISSUE_LABEL: Record<
  OwnerNameIssueCode | OwnerNameKanaIssueCode,
  string
> = {
  numeric_only: "数字のみ",
  symbol_only: "記号のみ",
  whitespace_only: "空白のみ",
  control_chars: "制御文字",
  too_long: "長すぎ",
  too_short: "短すぎ",
  mostly_digits: "数字過多",
  kana_non_kana: "カナに非カナ",
};

export const CONTACT_ISSUE_LABEL: Record<OwnerContactIssueCode, string> = {
  zip_suspicious: "郵便番号 不正",
  zip_unformatted: "郵便番号 未整形",
  phone_suspicious: "電話 不正",
  phone_non_phone: "電話 非電話",
  phone_unnormalized: "電話 未正規化",
};

// ---------------------------------------------------------------------------
// フィルタ種別（value=route の type / label=表示 / summaryKey=件数表示に使う summary キー）。
// route の ALL_TYPES と一致させる（drift はテストで検出）。
// ---------------------------------------------------------------------------

export interface NameTypeOption {
  value: NameFilterType;
  label: string;
  summaryKey: keyof OwnerNameQualitySummary;
}
export interface ContactTypeOption {
  value: ContactFilterType;
  label: string;
  summaryKey: keyof OwnerContactSummary;
}

export const NAME_TYPE_OPTIONS: NameTypeOption[] = [
  { value: "all", label: "すべて", summaryKey: "totalCandidates" },
  { value: "numeric_only", label: "数字のみ", summaryKey: "numericOnly" },
  { value: "symbol_only", label: "記号のみ", summaryKey: "symbolOnly" },
  { value: "whitespace_only", label: "空白のみ", summaryKey: "whitespaceOnly" },
  { value: "control_chars", label: "制御文字", summaryKey: "controlChars" },
  { value: "too_long", label: "長すぎ", summaryKey: "tooLong" },
  { value: "too_short", label: "短すぎ", summaryKey: "tooShort" },
  { value: "mostly_digits", label: "数字過多", summaryKey: "mostlyDigits" },
  { value: "kana_non_kana", label: "カナに非カナ", summaryKey: "kanaNonKana" },
];

export const CONTACT_TYPE_OPTIONS: ContactTypeOption[] = [
  { value: "all", label: "すべて", summaryKey: "totalCandidates" },
  { value: "zip_suspicious", label: "郵便番号 不正", summaryKey: "zipSuspicious" },
  { value: "zip_unformatted", label: "郵便番号 未整形", summaryKey: "zipUnformatted" },
  { value: "phone_suspicious", label: "電話 不正", summaryKey: "phoneSuspicious" },
  { value: "phone_non_phone", label: "電話 非電話", summaryKey: "phoneNonPhone" },
  { value: "phone_unnormalized", label: "電話 未正規化", summaryKey: "phoneUnnormalized" },
];

// ---------------------------------------------------------------------------
// format_candidate 行で「整形 apply」対象になるフィールド（contact-fix の field）を導出。
// recommendedAction==="format_candidate" は issue がすべて *_unformatted/_unnormalized で
// あることを保証する（route 側）。zip_unformatted→zip / phone_unnormalized→phone。
// ---------------------------------------------------------------------------

export function formatFixableFields(
  issues: OwnerContactIssueCode[],
): ContactField[] {
  const fields: ContactField[] = [];
  if (issues.includes("zip_unformatted")) fields.push("zip");
  if (issues.includes("phone_unnormalized")) fields.push("phone");
  return fields;
}

// ---------------------------------------------------------------------------
// 監査セル表示用エスケープ。制御 / ゼロ幅 / BOM / 双方向制御 / U+FFFD を \uXXXX へ。
// owner.name が control_chars を含む等のケースで、生値描画による不可視化 + bidi（RLO）の
// 表示順改変を防ぐ。通常文字・全角・絵文字（astral）は不変。no-control-regex 回避のため
// コードポイント数値比較で判定する。
// （DQ-04 の text-hygiene-display.visualizeTextHygiene と同方針。別ファイル・別名のため
//  当該 PR とのファイル衝突は無い＝独立して動作する。）
// ---------------------------------------------------------------------------

function isControlDisplayTarget(cp: number): boolean {
  return (
    (cp >= 0x00 && cp <= 0x08) || // C0（\t\n\r 除外）
    cp === 0x0b ||
    cp === 0x0c ||
    (cp >= 0x0e && cp <= 0x1f) ||
    (cp >= 0x7f && cp <= 0x9f) || // DEL + C1
    cp === 0x061c || // ALM
    (cp >= 0x200b && cp <= 0x200f) || // ゼロ幅 + LRM/RLM
    cp === 0x2060 || // WJ
    cp === 0xfeff || // BOM
    (cp >= 0x202a && cp <= 0x202e) || // bidi 埋め込み/上書き
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolate
    cp === 0xfffd // 置換文字
  );
}

export function escapeControlForAudit(
  value: string | null | undefined,
): string {
  if (!value) return "";
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isControlDisplayTarget(cp)
      ? `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`
      : ch;
  }
  return out;
}
