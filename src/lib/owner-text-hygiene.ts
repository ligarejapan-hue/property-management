/**
 * owner-text-hygiene.ts (DQ-04)
 *
 * 制御文字 / 文字化け（U+FFFD 等）を検出・無害化する純関数群（I/O なし・ユニットテスト可）。
 * 既存 owner-name-quality.ts (DQ-01) / owner-contact-format.ts (DQ-02) /
 * corporate-number-cleanup.ts と同スタイルで、戻り値は **コード/件数のみ**
 * （生値を返さない＝AuditLog / API 安全）。
 *
 * 設計（22B-dq-02-04-05-design.md DQ-04）の芯:
 * - **removable（自動除去が安全）**: C0/C1/DEL 制御文字（\t\n\r 以外）・ゼロ幅・BOM・bidi 制御。
 *   表示不能・不可視で **意味を持たない**＝除去しても情報は失われない。
 * - **audit-only（自動除去しない）**:
 *   - U+FFFD（置換文字）= デコード失敗の痕跡＝**元文字が不明**。除去すると欠損が見えなくなり、
 *     正しいエンコーディングでの再取込による修復機会を失う。原本からの取り直しを促す。
 *   - mojibake 残骸（誤デコードの逆変換は曖昧）= ヒューリスティック検出のみ。自動変換しない。
 *
 * 注意（誤検出回避）:
 * - `\t \n \r` と通常の全角文字は除去対象に含めない（正規の改行・住所の全角を保持）。
 *   sanitizeControlChars は連続空白（タブ/改行/全角空白含む）を 1 個の半角空白へ畳むのみ。
 * - 絵文字本体（surrogate pair）は壊さない。ゼロ幅 U+200D(ZWJ) は除去対象だが、これは
 *   owner の氏名/住所フィールドでの不可視ノイズ対策（配線は呼び出し側責任）。
 * - mojibake は「ラテン拡張が少数混じる正規名」を誤検出しないよう、誤デコード特有の
 *   連続シグネチャ（高位ラテン補助が 2 文字以上連続）に限定する。
 *
 * I/O 不使用（DB / next/server / AuditLog いずれにも依存しない）。配線は後続タスク。
 */

// ---------------------------------------------------------------------------
// 文字クラス（すべて \uXXXX エスケープで記述。owner-name-quality.ts と同様に
// \u エスケープで書くことで lint の no-control-regex に抵触させず、ソースに
// リテラルの制御文字（NUL 等）を埋め込まない＝git でテキスト扱いを維持する）。
// 範囲はすべて BMP のため u フラグ不要（ES2017 ターゲット安全）。
// ---------------------------------------------------------------------------

// C0 制御（U+0000-U+001F）から \t(U+0009)\n(U+000A)\r(U+000D) を除外、
// DEL(U+007F) と C1 制御（U+0080-U+009F）を含む。これらは removable。
const REMOVABLE_CONTROL_RE_G =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// ゼロ幅・BOM（U+200B ZWSP / U+200C ZWNJ / U+200D ZWJ / U+2060 WJ / U+FEFF BOM）。
const ZERO_WIDTH_RE_G = /[\u200B-\u200D\u2060\uFEFF]/g;

// bidi 制御（U+202A-U+202E 埋め込み/上書き / U+2066-U+2069 isolate）。表示偽装防止で除去。
const BIDI_RE_G = /[\u202A-\u202E\u2066-\u2069]/g;

// U+FFFD（置換文字）。audit-only（除去しない）。
const REPLACEMENT_CHAR = "\uFFFD";
const REPLACEMENT_CHAR_RE_G = /\uFFFD/g;

// removable 全体（control + zero-width + bidi）。sanitize / hasRemovable 判定で使う。
// U+FFFD は **含めない**（audit-only）。
const REMOVABLE_ALL_RE_G =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const REMOVABLE_ALL_RE = new RegExp(REMOVABLE_ALL_RE_G.source);

// 連続空白（半角/タブ/改行/各種空白 + 全角空白 U+3000）の畳み用。owner-name-quality と同方針。
const WHITESPACE_RUN_RE_G = /[\s　]+/g;

// mojibake ヒューリスティック（UTF-8 を Latin-1/CP1252 として誤読した残骸）。
// UTF-8 マルチバイト列を 1 バイトずつ Latin-1 として解釈すると、**先導バイト** が
// Â(U+00C2) / Ã(U+00C3) / â(U+00E2) のいずれかになり、その直後に高位ラテン補助
// （U+00A1-U+00FF）や CP1252 スマート記号（U+2013-U+2122）が続く連鎖になる（日本語等の
// マルチバイト誤読で頻出）。一方、正規のラテン拡張名は高位ラテン文字が **単発**（Cafe の
// e-acute / Muller の u-umlaut / naive の i-diaeresis）や、誤デコード由来でない連続
// （北欧名の Þórð / Ååå、café's / ü€ / àé 等）で、Â/Ã/â 先導を伴わない。
// よって **先導クラスを [ÂÃâ]（Â Ã â）に限定** し、後続クラスは U+00A1-U+00FF +
// CP1252 スマート記号（U+2013-U+2122）のまま据え置く。これにより連続アクセントの正規名を
// 誤検出せず、誤デコード特有の連鎖だけを拾う。
// 注意: Å(U+00C5) は **含めない**（北欧名 "Ååå" の先頭と衝突し正規名を誤検出するため）。
//
// ＋日本語等の 3 バイト列誤デコード（Codex P1）: 'あ'(UTF-8 E3 81 82) を CP1252 として
// 誤読すると 'ã'(U+00E3) + C1 制御 U+0081 + U+0082 になる。先導 'ã' は [ÂÃâ] に無いため
// 上記 (先導限定) では拾えず、しかも C1 制御は removable 集合に属するので検出漏れだと
// decideTextHygieneFix が **sanitize** 経路で C1 だけ剥がして 'ã' に潰し PII を二次破損する。
// 識別シグナルは「**高位ラテン(U+00A1-U+00FF) と C1 制御(U+0080-U+009F) の隣接**」。
// 正規アクセント名（Þórð / café's / Ååå / àé / Café / Müller）は C1 制御を一切含まない＝
// この隣接は起き得ない。よって順不同の 2 alternation（[¡-ÿ][C1] と [C1][¡-ÿ]）を追加し、
// 誤デコード特有の連鎖だけを mojibake(audit-only) として拾う（C1 範囲も \uXXXX エスケープ
// で記述し no-control-regex に抵触させない）。
const MOJIBAKE_RE =
  /[\u00C2\u00C3\u00E2][\u00A1-\u00FF\u2013-\u2122]|[\u00A1-\u00FF][\u0080-\u009F]|[\u0080-\u009F][\u00A1-\u00FF]/;

// ---------------------------------------------------------------------------
// inspectText: 検出のみ（read-only）。生値は返さない。
// ---------------------------------------------------------------------------

export interface TextHygieneReport {
  /** C0/C1/DEL 制御文字（\t\n\r 以外）を含むか。removable。 */
  hasControl: boolean;
  /** ゼロ幅 / BOM を含むか。removable。 */
  hasZeroWidth: boolean;
  /** bidi 制御を含むか。removable。 */
  hasBidi: boolean;
  /** U+FFFD（文字化け確定シグナル）を含むか。**audit-only**。 */
  hasReplacementChar: boolean;
  /** mojibake 残骸ヒューリスティックに一致したか。**audit-only**。 */
  hasMojibake: boolean;

  controlCount: number;
  zeroWidthCount: number;
  bidiCount: number;
  replacementCount: number;

  /** removable（control/zero-width/bidi）が 1 つでもあるか。 */
  hasRemovable: boolean;
  /** audit-only（U+FFFD / mojibake）が 1 つでもあるか。 */
  hasAuditOnly: boolean;
  /** 何らかの問題があるか（removable または audit-only）。 */
  hasAnyIssue: boolean;
}

function countMatches(input: string, re: RegExp): number {
  const m = input.match(re);
  return m ? m.length : 0;
}

/**
 * 文字列を検査して制御文字 / 文字化けの種別と件数を返す（read-only）。
 * 戻り値はブール / 数値のみで生値を含まない。
 */
export function inspectText(
  input: string | null | undefined,
): TextHygieneReport {
  const s = input ?? "";

  const controlCount = countMatches(s, REMOVABLE_CONTROL_RE_G);
  const zeroWidthCount = countMatches(s, ZERO_WIDTH_RE_G);
  const bidiCount = countMatches(s, BIDI_RE_G);
  const replacementCount = countMatches(s, REPLACEMENT_CHAR_RE_G);

  const hasControl = controlCount > 0;
  const hasZeroWidth = zeroWidthCount > 0;
  const hasBidi = bidiCount > 0;
  const hasReplacementChar = replacementCount > 0;
  const hasMojibake = MOJIBAKE_RE.test(s);

  const hasRemovable = hasControl || hasZeroWidth || hasBidi;
  const hasAuditOnly = hasReplacementChar || hasMojibake;

  return {
    hasControl,
    hasZeroWidth,
    hasBidi,
    hasReplacementChar,
    hasMojibake,
    controlCount,
    zeroWidthCount,
    bidiCount,
    replacementCount,
    hasRemovable,
    hasAuditOnly,
    hasAnyIssue: hasRemovable || hasAuditOnly,
  };
}

/** removable（control/zero-width/bidi）を 1 つでも含むか（U+FFFD は対象外）。 */
export function hasRemovableControlChars(
  input: string | null | undefined,
): boolean {
  if (!input) return false;
  return REMOVABLE_ALL_RE.test(input);
}

// ---------------------------------------------------------------------------
// sanitizeControlChars: removable のみ除去（U+FFFD は温存）+ 空白畳み + trim。
// ---------------------------------------------------------------------------

/**
 * removable な制御文字（C0/C1/DEL/ゼロ幅/BOM/bidi）を除去し、連続空白
 * （\t\n\r/半角/全角空白）を 1 個の半角空白へ畳んで trim する。
 *
 * **U+FFFD は除去しない**（欠損を隠さない＝audit-only）。正規の全角文字・絵文字本体は保持。
 * 冪等（2 回適用しても結果は変わらない）。
 */
export function sanitizeControlChars(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(REMOVABLE_ALL_RE_G, "")
    .replace(WHITESPACE_RUN_RE_G, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// classifyTextHygiene: 監査用分類（removable vs audit-only を明示分離）。
// ---------------------------------------------------------------------------

export type TextHygieneIssueCode =
  | "control_chars"
  | "zero_width"
  | "bidi"
  | "replacement_char"
  | "mojibake";

export type TextHygieneSeverity = "error" | "warning" | "info";

export interface TextHygieneResult {
  issues: TextHygieneIssueCode[];
  /** removable（自動 sanitize 可）な issue を含むか。 */
  removable: boolean;
  /** audit-only（自動除去しない）な issue を含むか。 */
  auditOnly: boolean;
  severity: TextHygieneSeverity | null;
}

// audit-only（U+FFFD / mojibake）= error（文字化け確定／要原本確認）。
// removable（control/zero-width/bidi）= warning（自動無害化で解消可）。
const ISSUE_SEVERITY: Record<TextHygieneIssueCode, TextHygieneSeverity> = {
  control_chars: "warning",
  zero_width: "warning",
  bidi: "warning",
  replacement_char: "error",
  mojibake: "error",
};

const AUDIT_ONLY_ISSUES = new Set<TextHygieneIssueCode>([
  "replacement_char",
  "mojibake",
]);

function maxSeverity(
  issues: TextHygieneIssueCode[],
): TextHygieneSeverity | null {
  const levels = new Set(issues.map((i) => ISSUE_SEVERITY[i]));
  if (levels.has("error")) return "error";
  if (levels.has("warning")) return "warning";
  if (levels.has("info")) return "info";
  return null;
}

/**
 * テキストの衛生品質を分類する。issue が無ければ issues 空・severity=null。
 * removable / auditOnly フラグで「自動 sanitize 可」と「人手要（除去しない）」を分離する。
 */
export function classifyTextHygiene(
  input: string | null | undefined,
): TextHygieneResult {
  const r = inspectText(input);
  const issues: TextHygieneIssueCode[] = [];
  if (r.hasControl) issues.push("control_chars");
  if (r.hasZeroWidth) issues.push("zero_width");
  if (r.hasBidi) issues.push("bidi");
  if (r.hasReplacementChar) issues.push("replacement_char");
  if (r.hasMojibake) issues.push("mojibake");

  const removable = issues.some((i) => !AUDIT_ONLY_ISSUES.has(i));
  const auditOnly = issues.some((i) => AUDIT_ONLY_ISSUES.has(i));

  return { issues, removable, auditOnly, severity: maxSeverity(issues) };
}

// ---------------------------------------------------------------------------
// decideTextHygieneFix: preview（sanitize / manual / none）。
// corporate-cleanup / name-fix / contact-fix と同型。
// ---------------------------------------------------------------------------

export type TextHygieneFixAction = "none" | "sanitize" | "manual";
export type TextHygieneFixManualReason =
  | "replacement_char"
  | "mojibake"
  | "would_be_empty"
  | null;

export interface TextHygieneFixProposal {
  action: TextHygieneFixAction;
  manualReason: TextHygieneFixManualReason;
  /** sanitize 時の機械補正後の値（route 側でマスクして返す）。それ以外は null。 */
  cleanedValue: string | null;
  changedFields: Array<"value">;
}

/**
 * テキストの自動補正可否を判定する。
 * - audit-only（U+FFFD / mojibake）を含むなら **action=manual**（自動除去しない・要原本確認）。
 *   removable が同居しても安全側で manual（人手判断に委ねる）。
 * - removable のみで sanitize により値が変わる → action=sanitize（cleanedValue 提示）。
 * - sanitize で（非空→）空になる → manual（would_be_empty・空書込を避ける）。
 * - 変化なし / 元から空 → action=none。
 */
export function decideTextHygieneFix(
  input: string | null | undefined,
): TextHygieneFixProposal {
  const original = input ?? "";
  const r = inspectText(original);

  // audit-only が混じる場合は自動補正しない（U+FFFD を優先理由に、無ければ mojibake）。
  if (r.hasReplacementChar || r.hasMojibake) {
    const manualReason: TextHygieneFixManualReason = r.hasReplacementChar
      ? "replacement_char"
      : "mojibake";
    return {
      action: "manual",
      manualReason,
      cleanedValue: null,
      changedFields: [],
    };
  }

  const cleaned = sanitizeControlChars(original);

  if (cleaned === original) {
    return {
      action: "none",
      manualReason: null,
      cleanedValue: original,
      changedFields: [],
    };
  }

  // ここに来るのは removable 除去 or 空白畳みで値が変わるケース。
  // 非空だったものが除去で空になる場合は空書込を避けて manual。
  if (cleaned === "" && original.trim() !== "") {
    return {
      action: "manual",
      manualReason: "would_be_empty",
      cleanedValue: null,
      changedFields: [],
    };
  }

  // 元から実質空（空白/不可視のみで trim 後も空）→ DQ なし扱い（none）。
  if (cleaned === "") {
    return {
      action: "none",
      manualReason: null,
      cleanedValue: original,
      changedFields: [],
    };
  }

  return {
    action: "sanitize",
    manualReason: null,
    cleanedValue: cleaned,
    changedFields: ["value"],
  };
}

// ---------------------------------------------------------------------------
// checkTextHygieneFixSafety: apply gate（enum コードのみ。contact-fix と同型）。
// ---------------------------------------------------------------------------

export type TextHygieneFixBlockReason =
  | "owner_archived"
  | "version_mismatch"
  | "no_change"
  | "would_be_empty"
  | "forbidden_value";

export interface TextHygieneFixSafetyInput {
  isArchived: boolean;
  versionMatches: boolean;
  currentValue: string | null;
  newValue: string | null;
}

export type TextHygieneFixSafetyResult =
  | { ok: true; newValue: string }
  | { ok: false; reasons: TextHygieneFixBlockReason[] };

/**
 * テキスト補正の安全条件チェック。複数違反は全件返す。
 * - 新値が空（trim 後）→ would_be_empty（空書込を許可しない）。
 * - 新値に removable 制御文字 / U+FFFD が残る → forbidden_value
 *   （apply は品質を必ず改善する方向に限定。再び DQ になる値を書かせない）。
 *   mojibake ヒューリスティックはここでは **適用しない**（人手承認済みの値が連続アクセントの
 *   正規名 = 例: 北欧名 "Þórð" を含むと誤検出で弾かれ、当該所有者が修正不能になるため）。
 */
export function checkTextHygieneFixSafety(
  input: TextHygieneFixSafetyInput,
): TextHygieneFixSafetyResult {
  const reasons: TextHygieneFixBlockReason[] = [];

  if (input.isArchived) reasons.push("owner_archived");
  if (!input.versionMatches) reasons.push("version_mismatch");
  if (input.newValue === input.currentValue) reasons.push("no_change");

  const nv = input.newValue ?? "";
  if (nv.trim() === "") {
    reasons.push("would_be_empty");
  } else if (hasRemovableControlChars(nv) || nv.includes(REPLACEMENT_CHAR)) {
    reasons.push("forbidden_value");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, newValue: nv };
}

// ---------------------------------------------------------------------------
// summary 集計（route の dry-run サマリ用）。
// ---------------------------------------------------------------------------

export interface TextHygieneSummary {
  controlChars: number;
  zeroWidth: number;
  bidi: number;
  replacementChar: number;
  mojibake: number;
  /** removable issue を持つ候補件数。 */
  removableCandidates: number;
  /** audit-only issue を持つ候補件数。 */
  auditOnlyCandidates: number;
  /** 何らかの issue を持つ候補件数。 */
  totalCandidates: number;
}

export function emptyTextHygieneSummary(): TextHygieneSummary {
  return {
    controlChars: 0,
    zeroWidth: 0,
    bidi: 0,
    replacementChar: 0,
    mojibake: 0,
    removableCandidates: 0,
    auditOnlyCandidates: 0,
    totalCandidates: 0,
  };
}

const ISSUE_TO_SUMMARY: Record<
  TextHygieneIssueCode,
  keyof TextHygieneSummary
> = {
  control_chars: "controlChars",
  zero_width: "zeroWidth",
  bidi: "bidi",
  replacement_char: "replacementChar",
  mojibake: "mojibake",
};

/** result に 1 つでも issue があれば種別ごとに加算し removable/auditOnly/total を更新する。 */
export function tallyTextHygiene(
  summary: TextHygieneSummary,
  result: TextHygieneResult,
): void {
  if (result.issues.length === 0) return;
  for (const issue of result.issues) summary[ISSUE_TO_SUMMARY[issue]]++;
  if (result.removable) summary.removableCandidates++;
  if (result.auditOnly) summary.auditOnlyCandidates++;
  summary.totalCandidates++;
}
