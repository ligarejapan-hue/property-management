/**
 * owner-name-quality.ts (DQ-01)
 *
 * 「氏名として成立しない値」を検出する純関数群（I/O なし・ユニットテスト可）。
 * 既存の owner-correction.ts / corporate-number-cleanup.ts と同じスタイルで、
 * 戻り値は **コードのみ**（氏名生値を返さない＝AuditLog / API 安全）。
 *
 * 設計（22D-dq01-design.md）:
 * - 誤検出回避の核心は「Unicode 文字 \p{L} を 1 文字でも含む氏名は数値/記号ゴミではない」。
 *   NFKC 後に判定するため全角数字・半角カナも吸収する。
 * - 数字間のハイフン/中黒/空白/括弧は区切り（\p{L} 非該当）なので "1-2-3" も numeric_only。
 * - 法人レコード（corporateNumber あり / 法人格語を含む）は too_long 上限を緩和。
 */

/** 氏名本体の問題コード。 */
export type OwnerNameIssueCode =
  | "whitespace_only"
  | "symbol_only"
  | "numeric_only"
  | "control_chars"
  | "too_long"
  | "too_short"
  | "mostly_digits";

/** nameKana の問題コード。 */
export type OwnerNameKanaIssueCode = "kana_non_kana";

export type OwnerNameSeverity = "error" | "warning" | "info";

export interface OwnerNameQualityInput {
  name: string;
  nameKana?: string | null;
  corporateNumber?: string | null;
}

export interface OwnerNameQualityResult {
  issues: OwnerNameIssueCode[];
  kanaIssues: OwnerNameKanaIssueCode[];
  severity: OwnerNameSeverity | null;
}

/** 氏名の既定の最大長（コードポイント数）。 */
export const OWNER_NAME_MAX_LEN = 60;
/** 法人レコードでの最大長（正式名称は長い）。 */
export const OWNER_NAME_CORP_MAX_LEN = 100;
/** mostly_digits とみなす数字比率の閾値。 */
export const OWNER_NAME_MOSTLY_DIGITS_RATIO = 0.7;

// 制御文字（C0 / DEL）と U+FFFD（文字化け置換文字）。NFKC でも除去されない。
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F\uFFFD]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE_G = /[\u0000-\u001F\u007F\uFFFD]/g;
const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{Nd}/u;

// 法人格・団体を示す語。too_long 上限の緩和判定に使う。
const CORP_WORD_RE =
  /(株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|㈱|㈲|医療法人|社会福祉法人|学校法人|宗教法人|管理組合|財団法人|一般財団法人|一般社団法人|公益財団法人|公益社団法人|特定非営利活動法人|協同組合|町内会|自治会)/;

// nameKana として許容する文字: ひらがな/カタカナ/長音/各種空白。
const NON_KANA_RE = /[^\u3040-\u309F\u30A0-\u30FF\u30FC\s\u3000]/u;

const ISSUE_SEVERITY: Record<OwnerNameIssueCode, OwnerNameSeverity> = {
  whitespace_only: "error",
  symbol_only: "error",
  numeric_only: "error",
  control_chars: "warning",
  too_long: "warning",
  too_short: "warning",
  mostly_digits: "info",
};
const KANA_SEVERITY: Record<OwnerNameKanaIssueCode, OwnerNameSeverity> = {
  kana_non_kana: "info",
};

function maxSeverity(
  issues: OwnerNameIssueCode[],
  kanaIssues: OwnerNameKanaIssueCode[],
): OwnerNameSeverity | null {
  const levels = new Set<OwnerNameSeverity>([
    ...issues.map((i) => ISSUE_SEVERITY[i]),
    ...kanaIssues.map((k) => KANA_SEVERITY[k]),
  ]);
  if (levels.has("error")) return "error";
  if (levels.has("warning")) return "warning";
  if (levels.has("info")) return "info";
  return null;
}

function isCorporateLike(
  input: OwnerNameQualityInput,
  normalized: string,
): boolean {
  const cn = input.corporateNumber;
  if (cn != null && cn.trim() !== "") return true;
  return CORP_WORD_RE.test(normalized);
}

/**
 * 氏名（と任意で nameKana）の品質を分類する。問題がなければ issues/kanaIssues は空。
 * 戻り値はコードのみで氏名生値を含まない。
 */
export function classifyOwnerNameQuality(
  input: OwnerNameQualityInput,
): OwnerNameQualityResult {
  const raw = input.name ?? "";
  const norm = raw.normalize("NFKC");
  const t = norm.trim();
  const issues: OwnerNameIssueCode[] = [];

  // 制御文字 / 文字化けは raw 全体で判定（NFKC/trim では除去されないため raw で十分）。
  if (CONTROL_RE.test(raw)) issues.push("control_chars");

  if (t.length === 0) {
    issues.push("whitespace_only");
  } else {
    const hasLetter = LETTER_RE.test(t);
    const hasDigit = DIGIT_RE.test(t);

    if (!hasLetter && hasDigit) {
      issues.push("numeric_only");
    } else if (!hasLetter && !hasDigit) {
      issues.push("symbol_only");
    }

    const codePoints = Array.from(t);
    const maxLen = isCorporateLike(input, t)
      ? OWNER_NAME_CORP_MAX_LEN
      : OWNER_NAME_MAX_LEN;
    if (codePoints.length > maxLen) issues.push("too_long");
    if (hasLetter && codePoints.length === 1) issues.push("too_short");

    if (hasLetter && hasDigit) {
      const digitCount = codePoints.filter((c) => DIGIT_RE.test(c)).length;
      if (digitCount / codePoints.length >= OWNER_NAME_MOSTLY_DIGITS_RATIO) {
        issues.push("mostly_digits");
      }
    }
  }

  const kanaIssues: OwnerNameKanaIssueCode[] = [];
  const kanaRaw = input.nameKana;
  if (kanaRaw != null) {
    const kt = kanaRaw.normalize("NFKC").trim();
    if (kt.length > 0 && NON_KANA_RE.test(kt)) {
      kanaIssues.push("kana_non_kana");
    }
  }

  return { issues, kanaIssues, severity: maxSeverity(issues, kanaIssues) };
}

// ---------------------------------------------------------------------------
// preview: 機械的に安全な補正のみ（制御文字/文字化け除去・空白正規化）
// ---------------------------------------------------------------------------

export type NameFixAction = "none" | "sanitize" | "manual";
export type NameFixManualReason =
  | "no_safe_autofix"
  | "name_would_be_empty"
  | null;

export interface OwnerNameFixProposal {
  action: NameFixAction;
  manualReason: NameFixManualReason;
  /** sanitize 時の機械補正後の値（route 側でマスクして返す）。それ以外は null。 */
  cleanedName: string | null;
  changedFields: Array<"name">;
}

/**
 * 機械的に安全な範囲で氏名を整える。表記改変（NFKC など）は行わず、
 * 制御文字 / U+FFFD を除去し、連続空白を 1 個へ畳んで trim する。
 */
export function sanitizeOwnerName(name: string): string {
  return name
    .replace(CONTROL_RE_G, "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

/**
 * 氏名の自動補正可否を判定する。
 * - 制御文字混入など sanitize で文字が残るものだけ action="sanitize"。
 * - 数値/記号/空白のみ等、実体が不明なゴミは action="manual"（人手 set / archive へ）。
 */
export function decideOwnerNameFix(name: string | null): OwnerNameFixProposal {
  const original = name ?? "";
  const cleaned = sanitizeOwnerName(original);

  if (cleaned === "") {
    // 元から実質空（空白/空文字）か、除去で空になったかを区別する。
    const manualReason: NameFixManualReason =
      original.trim() === "" ? "no_safe_autofix" : "name_would_be_empty";
    return { action: "manual", manualReason, cleanedName: null, changedFields: [] };
  }

  const cls = classifyOwnerNameQuality({ name: cleaned });
  const stillGarbage = cls.issues.some(
    (i) => i === "numeric_only" || i === "symbol_only" || i === "whitespace_only",
  );
  if (stillGarbage) {
    return {
      action: "manual",
      manualReason: "no_safe_autofix",
      cleanedName: null,
      changedFields: [],
    };
  }

  if (cleaned === original) {
    return {
      action: "none",
      manualReason: null,
      cleanedName: original,
      changedFields: [],
    };
  }

  return {
    action: "sanitize",
    manualReason: null,
    cleanedName: cleaned,
    changedFields: ["name"],
  };
}

// ---------------------------------------------------------------------------
// apply safety（enum コードのみ返す。owner archive safety と同型）
// ---------------------------------------------------------------------------

export type OwnerNameFixBlockReason =
  | "owner_archived"
  | "version_mismatch"
  | "name_would_be_empty"
  | "forbidden_value"
  | "no_change";

export interface OwnerNameFixSafetyInput {
  isArchived: boolean;
  versionMatches: boolean;
  currentName: string;
  newName: string;
}

export type OwnerNameFixSafetyResult =
  | { ok: true; newName: string }
  | { ok: false; reasons: OwnerNameFixBlockReason[] };

/**
 * 氏名補正の安全条件チェック。複数違反は全件返す。
 * 新値が再びゴミ（数値/記号/空白のみ）の場合は forbidden_value で拒否する。
 */
export function checkOwnerNameFixSafety(
  input: OwnerNameFixSafetyInput,
): OwnerNameFixSafetyResult {
  const reasons: OwnerNameFixBlockReason[] = [];

  if (input.isArchived) reasons.push("owner_archived");
  if (!input.versionMatches) reasons.push("version_mismatch");

  const trimmed = input.newName.trim();
  if (trimmed.length === 0) {
    reasons.push("name_would_be_empty");
  } else {
    const cls = classifyOwnerNameQuality({ name: input.newName });
    if (
      cls.issues.some(
        (i) =>
          i === "numeric_only" || i === "symbol_only" || i === "whitespace_only",
      )
    ) {
      reasons.push("forbidden_value");
    }
  }

  if (input.newName === input.currentName) reasons.push("no_change");

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, newName: input.newName };
}

// ---------------------------------------------------------------------------
// summary 集計ヘルパー（route の dry-run サマリ用）
// ---------------------------------------------------------------------------

export interface OwnerNameQualitySummary {
  numericOnly: number;
  symbolOnly: number;
  whitespaceOnly: number;
  controlChars: number;
  tooLong: number;
  tooShort: number;
  mostlyDigits: number;
  kanaNonKana: number;
  totalCandidates: number;
}

export function emptyOwnerNameQualitySummary(): OwnerNameQualitySummary {
  return {
    numericOnly: 0,
    symbolOnly: 0,
    whitespaceOnly: 0,
    controlChars: 0,
    tooLong: 0,
    tooShort: 0,
    mostlyDigits: 0,
    kanaNonKana: 0,
    totalCandidates: 0,
  };
}

const ISSUE_TO_SUMMARY: Record<
  OwnerNameIssueCode,
  keyof OwnerNameQualitySummary
> = {
  numeric_only: "numericOnly",
  symbol_only: "symbolOnly",
  whitespace_only: "whitespaceOnly",
  control_chars: "controlChars",
  too_long: "tooLong",
  too_short: "tooShort",
  mostly_digits: "mostlyDigits",
};

/** result に 1 つでも問題があれば種別ごとに加算し totalCandidates を 1 増やす。 */
export function tallyOwnerNameQuality(
  summary: OwnerNameQualitySummary,
  result: OwnerNameQualityResult,
): void {
  if (result.issues.length === 0 && result.kanaIssues.length === 0) return;
  for (const issue of result.issues) {
    summary[ISSUE_TO_SUMMARY[issue]]++;
  }
  if (result.kanaIssues.includes("kana_non_kana")) summary.kanaNonKana++;
  summary.totalCandidates++;
}
