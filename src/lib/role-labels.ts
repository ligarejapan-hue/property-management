/**
 * ロールの日本語表示名(共有マップ)。
 * ユーザー一覧・個別権限編集など、ロールを画面表示する箇所はここを参照する
 * (英語コードの生表示を避ける・B-5 UI総点検)。
 */
export const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  office_staff: "事務担当",
  field_staff: "現地担当",
};
