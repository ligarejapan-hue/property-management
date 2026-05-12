/**
 * 物件種別の共有定数
 *
 * UI・バリデーター・CSV取込で同じ値を参照するための単一の定義元。
 *
 * 後方互換値 (building / unit):
 *   既存の取込済みデータが参照している旧値。
 *   新規登録には使わないが、一覧・詳細画面で "（旧）" 付きで表示する。
 */

// ── 全列挙値 ─────────────────────────────────────────────────────────────────

export const PROPERTY_TYPE_VALUES = [
  // アクティブな種別（新規登録・CSV で推奨）
  "land",
  "house",
  "apartment_unit",
  "apartment_building",
  "apartment_block",
  "store",
  "office",
  "warehouse",
  "factory",
  "parking",
  "other",
  "unknown",
  // 後方互換（旧値）
  "building",
  "unit",
] as const;

export type PropertyTypeValue = (typeof PROPERTY_TYPE_VALUES)[number];

// ── 表示ラベル ────────────────────────────────────────────────────────────────

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  land:                "土地",
  house:               "戸建",
  apartment_unit:      "区分マンション",
  apartment_building:  "一棟マンション",
  apartment_block:     "一棟アパート",
  store:               "店舗",
  office:              "事務所",
  warehouse:           "倉庫",
  factory:             "工場",
  parking:             "駐車場",
  other:               "その他",
  unknown:             "不明",
  // 旧値（既存データ表示用）
  building:            "建物（旧）",
  unit:                "区分（旧）",
};

// ── UI セレクト用オプション ───────────────────────────────────────────────────
// 新規登録・編集フォームで表示する選択肢。旧値は末尾にまとめる。

export const PROPERTY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "land",               label: "土地" },
  { value: "house",              label: "戸建" },
  { value: "apartment_unit",     label: "区分マンション" },
  { value: "apartment_building", label: "一棟マンション" },
  { value: "apartment_block",    label: "一棟アパート" },
  { value: "store",              label: "店舗" },
  { value: "office",             label: "事務所" },
  { value: "warehouse",          label: "倉庫" },
  { value: "factory",            label: "工場" },
  { value: "parking",            label: "駐車場" },
  { value: "other",              label: "その他" },
  { value: "unknown",            label: "不明" },
  // 旧値（既存データを持つレコード編集時に選択肢として残す）
  { value: "building",           label: "建物（旧）" },
  { value: "unit",               label: "区分（旧）" },
];

// ── CSV 日本語ラベル → enum 値マッピング ──────────────────────────────────────
// CSV の「種別」列に日本語が入っている場合に正規化する。
// 重要: 新規取込では旧値（building / unit）を出力しない。曖昧な日本語ラベルは
// active な enum 値にだけ寄せる。「建物」は単独だと apartment_unit/building/house の
// 区別がつかないので "unknown" にフォールバックして人手判断に委ねる。

// ════════════════════════════════════════════════════════════════════════════
// 案件状況 (CaseStatus)
// ════════════════════════════════════════════════════════════════════════════

// アクティブな16値。deprecated (waiting_registry / done) はここに含めない。
export const CASE_STATUS_VALUES = [
  "new_case",
  "contacting_owner",
  "owner_contacted",
  "site_checked",
  "confirming_owner",
  "dm_target",
  "dm_sent",
  "response_received",
  "appraisal",
  "negotiating",
  "brokerage_obtained",
  "on_sale",
  "hold",
  "other_brokerage",
  "sold",
  "closed",
] as const;

export type CaseStatusValue = (typeof CASE_STATUS_VALUES)[number];

export const CASE_STATUS_LABELS: Record<string, string> = {
  new_case:           "新規",
  contacting_owner:   "所有者連絡中",
  owner_contacted:    "所有者連絡済",
  site_checked:       "現地確認済",
  confirming_owner:   "所有者確認中",
  dm_target:          "DM対象",
  dm_sent:            "DM送付済",
  response_received:  "反響あり",
  appraisal:          "査定中",
  negotiating:        "商談中",
  brokerage_obtained: "媒介取得済",
  on_sale:            "販売中",
  hold:               "保留",
  other_brokerage:    "他社媒介",
  sold:               "売却完了",
  closed:             "終了",
  // deprecated — 既存データ表示のみ
  waiting_registry:   "登記待ち（旧）",
  done:               "完了（旧）",
};

export const CASE_STATUS_OPTIONS: { value: string; label: string }[] = CASE_STATUS_VALUES.map(
  (v) => ({ value: v, label: CASE_STATUS_LABELS[v] }),
);

export const CASE_STATUS_JP_TO_VALUE: Record<string, string> = {
  "新規":         "new_case",
  "所有者連絡中": "contacting_owner",
  "所有者連絡済": "owner_contacted",
  "現地確認済":   "site_checked",
  "所有者確認中": "confirming_owner",
  "DM対象":       "dm_target",
  "DM送付済":     "dm_sent",
  "反響あり":     "response_received",
  "査定中":       "appraisal",
  "商談中":       "negotiating",
  "媒介取得済":   "brokerage_obtained",
  "販売中":       "on_sale",
  "保留":         "hold",
  "他社媒介":     "other_brokerage",
  "売却完了":     "sold",
  "終了":         "closed",
  // 旧ラベル → 新値（deprecated 値を DB に新規投入しないための正規化）
  "登記待ち":     "confirming_owner",
  "謄本待ち":     "confirming_owner",
  "完了":         "closed",
};

// deprecated 旧 enum 値 → 新値
const CASE_STATUS_DEPRECATED_MAP: Record<string, CaseStatusValue> = {
  waiting_registry: "confirming_owner",
  done:             "closed",
};

const CASE_STATUS_VALUE_SET = new Set<string>(CASE_STATUS_VALUES);

/**
 * CSV・API 入力値（日本語ラベル / 旧 enum 値 / 新 enum 値）を
 * アクティブな CaseStatusValue に正規化する。
 * 不明な値は null を返す（呼び出し側で new_case フォールバックまたは除去）。
 */
export function normalizeCaseStatusInput(value: unknown): CaseStatusValue | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const v = value.trim();
  // already a valid active value
  if (CASE_STATUS_VALUE_SET.has(v)) return v as CaseStatusValue;
  // deprecated enum value → new value
  if (CASE_STATUS_DEPRECATED_MAP[v]) return CASE_STATUS_DEPRECATED_MAP[v];
  // Japanese label → new value
  const fromJp = CASE_STATUS_JP_TO_VALUE[v];
  if (fromJp && CASE_STATUS_VALUE_SET.has(fromJp)) return fromJp as CaseStatusValue;
  return null;
}

// ════════════════════════════════════════════════════════════════════════════

export const PROPERTY_TYPE_JP_TO_VALUE: Record<string, string> = {
  "土地":         "land",
  "戸建":         "house",
  "戸建て":       "house",
  "一戸建":       "house",
  "一戸建て":     "house",
  "区分マンション": "apartment_unit",
  "区分":         "apartment_unit",
  "区分所有":     "apartment_unit",
  "一棟マンション": "apartment_building",
  "マンション":   "apartment_building",
  "一棟アパート":  "apartment_block",
  "アパート":     "apartment_block",
  "店舗":         "store",
  "事務所":       "office",
  "オフィス":     "office",
  "倉庫":         "warehouse",
  "工場":         "factory",
  "駐車場":       "parking",
  "その他":       "other",
  "不明":         "unknown",
  // 「建物」単独は曖昧 → unknown（旧 importer は "building" にマップしていた）
  "建物":         "unknown",
};
