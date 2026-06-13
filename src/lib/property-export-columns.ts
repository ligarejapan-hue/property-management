/**
 * 物件CSV export（GET /api/properties/export）の出力列レジストリ。
 *
 * - `key`    : ?columns= で使う安定英語キー（日本語ヘッダのラベル変更に影響されない）。
 * - `header` : CSV に出力する日本語ヘッダ名（列順はこの配列順）。
 *
 * 値の生成ロジックは route 側に置き、本モジュールは「どの列を・どの順で出すか」だけを担う。
 * 無指定（?columns= 無し）は全列＝現行15列順で後方互換。
 */
export interface ExportColumn {
  /** ?columns= で指定する安定英語キー */
  key: string;
  /** CSV 日本語ヘッダ名 */
  header: string;
}

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: "mgmtId", header: "管理ID" },
  { key: "propertyType", header: "物件種別" },
  { key: "address", header: "住所" },
  { key: "lotNumber", header: "地番" },
  { key: "buildingNumber", header: "家屋番号" },
  { key: "realEstateNumber", header: "不動産番号" },
  { key: "registryStatus", header: "登記状況" },
  { key: "dmStatus", header: "DM判断" },
  { key: "caseStatus", header: "案件ステータス" },
  { key: "introductionRoute", header: "導入ルート" },
  { key: "assigneeName", header: "担当者名" },
  { key: "ownerNames", header: "所有者名" },
  { key: "updatedAt", header: "更新日時" },
  { key: "createdAt", header: "作成日時" },
  { key: "postalCode", header: "郵便番号" },
] as const;

/**
 * ?columns= の値から出力対象列を解決する。
 *
 * - null / undefined（未指定）→ 全列（後方互換）。
 * - 指定あり → 既知キーのみを **EXPORT_COLUMNS の定義順** に正規化（ユーザー指定順は
 *   採用しない＝出力安定）。未知キー・空要素は無視。重複は1回。
 * - 結果が0件（全て未知/空）→ 全列にフォールバック（列ゼロの無意味な CSV を出さない。
 *   なお UI 側はゼロ列選択時に出力ボタンを無効化する）。
 */
export function resolveExportColumns(
  columnsParam: string | null | undefined,
): readonly ExportColumn[] {
  if (columnsParam == null) return EXPORT_COLUMNS;

  const requested = new Set(
    columnsParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  if (requested.size === 0) return EXPORT_COLUMNS;

  const selected = EXPORT_COLUMNS.filter((c) => requested.has(c.key));
  return selected.length > 0 ? selected : EXPORT_COLUMNS;
}
