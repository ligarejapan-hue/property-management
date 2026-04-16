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

export const PROPERTY_TYPE_JP_TO_VALUE: Record<string, string> = {
  "土地":         "land",
  "戸建":         "house",
  "戸建て":       "house",
  "区分マンション": "apartment_unit",
  "区分":         "apartment_unit",   // 新規 CSV は apartment_unit へ
  "一棟マンション": "apartment_building",
  "一棟アパート":  "apartment_block",
  "店舗":         "store",
  "事務所":       "office",
  "倉庫":         "warehouse",
  "工場":         "factory",
  "駐車場":       "parking",
  "その他":       "other",
  "不明":         "unknown",
  // 旧ラベルは後方互換として保持
  "建物":         "building",
};
