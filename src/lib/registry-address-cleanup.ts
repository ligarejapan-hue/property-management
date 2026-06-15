// DQ-03: 所有者住所に混入した「登記事項証明書由来の非住所文字列」の検出 + 補正判定。
//
// 純関数（I/O なし）。会社法人等番号(12桁)/法人番号(13桁) の混入除去は別レイヤ
// （corporate-number-cleanup.ts）が担当し、本モジュールは **触れない**（裸13桁の誤除去を避け、
// 不動産番号は「ラベル付き13桁の監査専用」として扱う）。
//
// 設計原則（22B-dq03-pattern-survey §6 / corporate-cleanup #175 踏襲）:
//  1. 自動書き換え禁止。検出は監査、変更は呼び出し側（route）の明示 apply のみ。
//  2. **保守的検出**: 住所として正当な番地・建物名（例「第2号棟」）を消さない。
//     - 除去対象は「アンカーが一意」な高信頼類型のみ（受付番号/和暦日付/登記原因/持分/証明書定型文）。
//     - 裸の小整数（順位番号らしき数字）は **検出しない**（番地と区別不能ゆえ偽陽性を作らない）。
//     - 地番/家屋番号ラベル・不動産番号(ラベル付き13桁)・床面積 等は **監査専用**（除去せず manual フラグ）。
//  3. raw-visible gate / 権限 / 楽観ロック / 監査ログは route 側で行う（本モジュールは値判定のみ）。

export type RegistryStringType =
  // 除去可能（高アンカー）
  | "receipt_number" // T2 受付番号
  | "registration_cause" // T4 登記原因（日付+原因語）
  | "registration_date" // T3 登記日付（和暦）
  | "share_fraction" // T7 持分
  | "certificate_meta" // T9 証明書メタ/定型文
  // 監査専用（除去しない）
  | "real_estate_number" // T8 不動産番号（ラベル付き13桁）
  | "parcel_label" // T5 地番ラベル
  | "building_number" // T6 家屋番号ラベル
  | "structure_area" // T10 床面積
  | "rank_number"; // T1 順位番号（ラベル付きのみ）

export type RegistryAddressCleanupAction = "none" | "cleanup" | "manual";
export type RegistryAddressManualReason = "audit_only" | null;

export interface RegistryAddressCleanupInput {
  address: string | null;
}

export interface RegistryStringDetectionItem {
  type: RegistryStringType;
  text: string;
  removable: boolean;
}

export interface RegistryAddressCleanupProposal {
  action: RegistryAddressCleanupAction;
  manualReason: RegistryAddressManualReason;
  /** 検出した全セグメント（route 側でマスクして表示。生値は本オブジェクト内のみ）。 */
  detected: RegistryStringDetectionItem[];
  /** 検出した type のユニーク一覧（安定順）。 */
  detectedTypes: RegistryStringType[];
  /** 除去対象として検出した type。 */
  removableTypes: RegistryStringType[];
  /** 監査専用（除去しない）として検出した type。 */
  auditOnlyTypes: RegistryStringType[];
  /** 除去後の住所（除去が無ければ原値）。空になれば null。 */
  cleanedAddress: string | null;
  /** cleanedAddress が原値から変化したか。 */
  changed: boolean;
  /** 監査専用の検出があり、人手確認が必要か。 */
  manualReviewRequired: boolean;
}

// 元号（和暦）。
const ERA = "(?:平成|令和|昭和|大正|明治)";
// 全角/半角数字。
const D = "[0-9０-９]";
// 和暦 年月日（元号アンカー必須＝住所中の裸数字を誤検出しない）。
const WAREKI_DATE = `${ERA}\\s*(?:${D}+|元)\\s*年\\s*${D}+\\s*月\\s*${D}+\\s*日`;
// 登記原因の閉じた語彙（長いものを先に並べ、所有権移転 が 移転 に食われないようにする）。
const CAUSE = "(?:売買|相続|贈与|所有権移転|所有権保存|移転|設定|抹消|分割|合併|交換|競売|時効取得)";

// 除去可能パターン（順序が重要: 登記原因[日付+原因]を日付単独より先に除去し、原因語の孤立を防ぐ）。
const REMOVABLE_PATTERNS: { type: RegistryStringType; re: () => RegExp }[] = [
  // 受付番号: 過検出防止のため 2 分岐に厳格化（MUST-FIX #1）。
  //  - 完全ラベル「受付番号」: 第/号 は任意（受付番号 自体が強アンカー＝住所に出ない）。
  //  - 短縮「受付」: **第 + 末尾号を必須**（さもないと「受付3号館」「受付1号棟」の正当住所を消す）。
  { type: "receipt_number", re: () => new RegExp(`受付番号\\s*第?\\s*${D}+\\s*号?|受付\\s*第\\s*${D}+\\s*号`, "g") },
  { type: "registration_cause", re: () => new RegExp(`${WAREKI_DATE}\\s*${CAUSE}`, "g") },
  { type: "registration_date", re: () => new RegExp(WAREKI_DATE, "g") },
  { type: "share_fraction", re: () => new RegExp(`持分\\s*${D}+\\s*分の\\s*${D}+`, "g") },
  {
    type: "certificate_meta",
    re: () =>
      /(?:全部事項証明書|現在事項証明書|これは登記記録に記録されている事項の全部を証明した書面である|下線のあるものは抹消事項|共同担保目録)/g,
  },
];

// 監査専用パターン（検出のみ・除去しない）。
const AUDIT_ONLY_PATTERNS: { type: RegistryStringType; re: () => RegExp }[] = [
  // 不動産番号は **ラベル付き13桁** のみ（裸13桁は corporate 側との衝突を避け検出しない）。
  { type: "real_estate_number", re: () => new RegExp(`不動産番号\\s*${D}{13}`, "g") },
  { type: "parcel_label", re: () => new RegExp(`地番\\s*${D}[${"0-9０-９番号の丁目\\-－"}]*`, "g") },
  { type: "building_number", re: () => new RegExp(`家屋番号\\s*${D}[${"0-9０-９番号の丁目\\-－"}]*`, "g") },
  // 床面積: 「床面積」アンカー必須（無アンカーだと「80平米のマンション」等を誤検出する・SHOULD-FIX #5）。
  { type: "structure_area", re: () => new RegExp(`床面積\\s*${D}+(?:[.．]${D}+)?\\s*(?:㎡|平方メートル|平米)`, "g") },
  // 順位番号は **ラベル付きのみ**（裸の小整数は番地と区別不能ゆえ検出しない）。
  { type: "rank_number", re: () => new RegExp(`順位番号\\s*${D}+|付記\\s*${D}+\\s*号`, "g") },
];

const TYPE_ORDER: RegistryStringType[] = [
  "receipt_number",
  "registration_cause",
  "registration_date",
  "share_fraction",
  "certificate_meta",
  "real_estate_number",
  "parcel_label",
  "building_number",
  "structure_area",
  "rank_number",
];

function emptyToNull(s: string | null): string | null {
  if (s == null) return null;
  return s.trim() === "" ? null : s;
}

/** 除去後に残る余分な空白（半角/全角）を 1 つに畳んで trim する。 */
function collapseWhitespace(s: string): string {
  return s.replace(/[ 　]+/g, " ").trim();
}

export function decideRegistryAddressCleanup(
  input: RegistryAddressCleanupInput,
): RegistryAddressCleanupProposal {
  const address = input.address;
  const base: RegistryAddressCleanupProposal = {
    action: "none",
    manualReason: null,
    detected: [],
    detectedTypes: [],
    removableTypes: [],
    auditOnlyTypes: [],
    cleanedAddress: address,
    changed: false,
    manualReviewRequired: false,
  };

  if (address == null || address.trim() === "") return base;

  const detected: RegistryStringDetectionItem[] = [];

  // 1. 検出（removable / audit-only を原文に対して収集。除去はまだしない）。
  //    スパン（start/end）を持たせ、登記原因が覆う登記日付は二重計上しない（SHOULD-FIX #4）。
  interface Span {
    type: RegistryStringType;
    text: string;
    start: number;
    end: number;
  }
  const removableSpans: Span[] = [];
  for (const { type, re } of REMOVABLE_PATTERNS) {
    for (const m of address.matchAll(re())) {
      if (m[0] && m.index != null) {
        removableSpans.push({ type, text: m[0], start: m.index, end: m.index + m[0].length });
      }
    }
  }
  const causeSpans = removableSpans.filter((s) => s.type === "registration_cause");
  for (const s of removableSpans) {
    // registration_date が registration_cause スパンに内包される場合は date を捨てる
    // （同一スパンを「登記原因」と「登記日付」で二重にバッジ表示しない）。
    if (
      s.type === "registration_date" &&
      causeSpans.some((c) => c.start <= s.start && s.end <= c.end)
    ) {
      continue;
    }
    detected.push({ type: s.type, text: s.text, removable: true });
  }
  for (const { type, re } of AUDIT_ONLY_PATTERNS) {
    for (const m of address.matchAll(re())) {
      if (m[0]) detected.push({ type, text: m[0], removable: false });
    }
  }

  if (detected.length === 0) return base;

  const detectedSet = new Set(detected.map((d) => d.type));
  const detectedTypes = TYPE_ORDER.filter((t) => detectedSet.has(t));
  const removableTypes = detectedTypes.filter((t) =>
    REMOVABLE_PATTERNS.some((p) => p.type === t),
  );
  const auditOnlyTypes = detectedTypes.filter((t) =>
    AUDIT_ONLY_PATTERNS.some((p) => p.type === t),
  );
  const manualReviewRequired = auditOnlyTypes.length > 0;

  // 2. 除去（removable パターンを順序どおりに適用。audit-only は触らない）。
  let working = address;
  for (const { re } of REMOVABLE_PATTERNS) {
    working = working.replace(re(), " ");
  }

  let cleanedAddress: string | null;
  let changed: boolean;
  if (working === address) {
    // removable が無い（= audit-only のみ検出）。原値を保持する。
    cleanedAddress = address;
    changed = false;
  } else {
    cleanedAddress = emptyToNull(collapseWhitespace(working));
    changed = cleanedAddress !== address;
  }

  let action: RegistryAddressCleanupAction;
  let manualReason: RegistryAddressManualReason = null;
  if (changed) {
    action = "cleanup";
  } else {
    // 除去で値が変わらない（= 監査専用のみ、または除去対象が実質無し）→ 人手確認へ。
    action = "manual";
    manualReason = "audit_only";
  }

  return {
    action,
    manualReason,
    detected,
    detectedTypes,
    removableTypes,
    auditOnlyTypes,
    cleanedAddress,
    changed,
    manualReviewRequired,
  };
}
