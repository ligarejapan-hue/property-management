/**
 * 取込種別の利用者向けラベルを集約する。
 * 内部値（property_csv / owner_csv / registry_pdf 等）はAPI/DBの仕様として固定し、
 * UI ではここで定義する日本語表示のみを使う。
 */

export const IMPORT_TYPE_LABELS: Record<string, string> = {
  // property_csv は内部値だが、利用者向けには受付帳ベースの取込のため「受付帳CSV」と表示する
  property_csv: "受付帳CSV",
  owner_csv: "所有者CSV",
  // 同一の謄本PDFを指す内部値が2系統存在するため両方をラベリング
  property_pdf: "謄本PDF",
  registry_pdf: "謄本PDF",
  dm_history_csv: "DM履歴CSV",
  investigation_csv: "調査CSV",
};

/**
 * 取込種別を日本語ラベルに変換する。未知の値はそのまま返す（フォールバック）。
 */
export function getImportTypeLabel(type: string | null | undefined): string {
  if (!type) return "-";
  return IMPORT_TYPE_LABELS[type] ?? type;
}

/**
 * 取込履歴フィルタ用の選択肢。先頭に "" (すべて) を含む。
 * value は API送信用の内部値、label は表示用ラベル。
 */
export const IMPORT_TYPE_FILTER_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "すべての種別" },
  { value: "property_csv", label: IMPORT_TYPE_LABELS.property_csv },
  { value: "owner_csv", label: IMPORT_TYPE_LABELS.owner_csv },
  { value: "property_pdf", label: IMPORT_TYPE_LABELS.property_pdf },
  { value: "dm_history_csv", label: IMPORT_TYPE_LABELS.dm_history_csv },
  { value: "investigation_csv", label: IMPORT_TYPE_LABELS.investigation_csv },
];
