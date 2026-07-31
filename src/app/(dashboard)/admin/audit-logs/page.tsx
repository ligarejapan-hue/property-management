"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import Link from "next/link";
import { Loader2, Search, RotateCcw } from "lucide-react";
import { debounce } from "@/lib/debounce";
import { formatJaDateTime } from "@/lib/format-datetime";

interface AuditLog {
  id: string;
  userId: string;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string | null };
}

const ACTION_LABELS: Record<string, string> = {
  login: "ログイン",
  login_failed: "ログイン失敗",
  logout: "ログアウト",
  property_create: "物件作成",
  property_update: "物件更新",
  property_delete: "物件削除",
  property_list: "物件一覧",
  owner_create: "オーナー作成",
  owner_update: "オーナー更新",
  building_create: "棟作成",
  building_update: "棟更新",
  unit_create: "部屋作成",
  unit_update: "部屋更新",
  csv_import: "CSVインポート",
  csv_export: "CSVエクスポート",
  photo_upload: "写真アップロード",
  photo_delete: "写真削除",
  permission_update: "権限変更",
  password_reset: "パスワードリセット",
  user_create: "ユーザー作成",
  user_update: "ユーザー更新",
  template_create: "テンプレート作成",
  template_update: "テンプレート更新",
  template_delete: "テンプレート削除",
  investigation_trigger: "調査実行",
  investigation_confirm: "調査確定",
  investigation_fetch: "調査情報取得",
  import_job_mark_failed: "取込を手動失敗化",
  import_job_rollback: "取込ロールバック",
  import_row_resolve: "取込行解決",
  import_rows_bulk_resolve: "取込行の一括解決",
  reception_owner_manual_link: "受付帳×所有者の手動紐づけ",
  reception_owner_csv_import: "受付帳×所有者の取込",
  reception_property_csv_import: "受付帳から物件作成",
  // B-5(UI総点検): 監査ログに実際に記録される action を日本語で収載する。
  // 未収載の古いコードは従来どおり生表示にフォールバックする。
  // --- 汎用(棟・部屋など writeAuditLog の汎用 action) ---
  create: "作成",
  update: "更新",
  delete: "削除",
  restore: "復元",
  complete: "完了",
  bulk_update: "一括更新",
  // --- 物件のワンクリック操作(action:* 形式で記録される) ---
  "action:confirm_investigation": "調査情報を確認",
  "action:set_dm_send": "DM送付可に設定",
  "action:set_dm_no_send": "DM送付不可に設定",
  "action:set_dm_hold": "DM未判断に設定",
  "action:mark_registry_obtained": "登記取得済みに設定",
  "action:assign_to_me": "自分を担当者に設定",
  // --- 閲覧・検索 ---
  property_view: "物件閲覧",
  property_suggest: "物件検索(候補)",
  property_dm_log_view: "DM履歴閲覧",
  owner_view: "オーナー閲覧",
  owner_list: "オーナー一覧",
  owner_search: "オーナー検索",
  attachment_search: "添付ファイル検索",
  attachment_trash_list: "添付ゴミ箱一覧",
  display_name_audit_view: "表示名監査の閲覧",
  // --- CSVエクスポート ---
  property_csv_export: "物件CSVエクスポート",
  property_dm_csv_export: "DM宛先CSVエクスポート",
  property_address_dm_csv_export: "物件宛DM CSVエクスポート",
  import_error_csv_export: "取込エラー行CSVエクスポート",
  // --- オーナー関連 ---
  owner_memo_create: "オーナーメモ作成",
  owner_csv_import: "オーナーCSVインポート",
  owner_created_from_reception: "受付帳からオーナー作成",
  owner_relink: "オーナー再紐づけ",
  candidate_judge: "物件候補の判定",
  // --- 所有者補正・品質チェック ---
  owner_correction_candidates_list: "補正候補一覧",
  owner_correction_address_fill: "住所補完",
  owner_correction_archive: "オーナーをアーカイブ",
  owner_correction_merge_preview: "オーナー統合プレビュー",
  owner_correction_merge: "オーナー統合実行",
  owner_correction_mislink_preview: "誤紐づけ解除プレビュー",
  owner_correction_mislink: "誤紐づけ解除",
  owner_correction_name_fix: "氏名補正",
  owner_correction_contact_fix: "連絡先補正",
  // text-fix は氏名/カナ/住所の3フィールド共通 action のため中立な名称にする(@codex R2)
  owner_correction_text_fix: "文字列補正",
  owner_correction_corporate_candidates_list: "法人番号候補一覧",
  owner_correction_corporate_candidate_view: "法人番号候補の閲覧",
  owner_correction_corporate_bulk_apply: "法人番号一括反映",
  owner_correction_corporate_restore_list: "法人番号復元候補一覧",
  owner_correction_corporate_restore_apply: "法人番号復元",
  owner_corporate_lookup: "法人番号検索",
  owner_corporate_apply: "法人番号反映",
  owner_corporate_cleanup_preview: "法人番号混入除去プレビュー",
  owner_corporate_cleanup_apply: "法人番号混入除去",
  owner_registry_address_candidates_list: "登記文字列候補一覧",
  owner_registry_address_cleanup_preview: "登記文字列除去プレビュー",
  owner_registry_address_cleanup_apply: "登記文字列除去",
  owner_name_quality_candidates_list: "氏名チェック候補一覧",
  owner_contact_quality_candidates_list: "連絡先チェック候補一覧",
  owner_text_hygiene_candidates_list: "文字列チェック候補一覧",
  // --- 現地調査 ---
  field_survey_pin_create: "調査ピン作成",
  field_survey_pin_update: "調査ピン更新",
  field_survey_pin_delete: "調査ピン削除",
  field_survey_pin_view: "調査ピン閲覧",
  field_survey_pin_list_others: "他担当の調査ピン一覧",
  field_survey_pin_photo_create: "調査ピン写真追加",
  field_survey_pin_photo_delete: "調査ピン写真削除",
  field_survey_session_start: "巡回開始",
  field_survey_session_end: "巡回終了",
  field_survey_session_auto_end: "巡回の自動終了",
  field_survey_session_cancel: "巡回中止",
  field_survey_session_view: "巡回記録の閲覧",
  field_survey_session_list_view: "巡回一覧の閲覧（他スタッフ分）",
  field_survey_track_view: "移動軌跡の閲覧",
  // --- 謄本・取込 ---
  registry_search: "謄本検索",
  registry_auto_fetch: "謄本自動取得",
  registry_location_purchase: "謄本の有料請求（台帳）",
  registry_settings_update: "謄本設定更新",
  registry_ocr_draft: "謄本OCR下書き",
  registry_pdf_bulk_upload: "謄本PDF一括取込",
  registry_pdf_bulk_resume: "謄本PDF一括取込の再開",
  registry_pdf_manual_attach: "謄本PDF手動添付",
  registry_pdf_download: "謄本PDFダウンロード",
  registry_pdf_preview: "謄本PDFプレビュー",
  pdf_import: "PDF取込",
  // --- 売却促進DM ---
  sale_dm_settings_update: "売却DM設定更新",
  sale_dm_variant_create: "売却DM文面作成",
  sale_dm_variant_update: "売却DM文面更新",
  sale_dm_variant_delete: "売却DM文面削除",
  sale_dm_campaign_create: "売却DMキャンペーン作成",
  sale_dm_campaign_view: "売却DMキャンペーン閲覧",
  sale_dm_campaign_csv_export: "売却DM CSVエクスポート",
  sale_dm_campaign_print: "売却DM印刷",
  sale_dm_assign_variants: "売却DM文面割当",
  sale_dm_draft_update: "売却DM下書き更新",
  sale_dm_draft_regenerate: "売却DM文面再生成",
  sale_dm_drafts_confirm: "売却DM下書き確定",
  sale_dm_draft_mark_sent: "売却DM送付済みに設定",
  sale_dm_draft_outcome_update: "売却DM反応の記録",
  sale_dm_undeliverable_clear: "売却DM宛先不明の解除",
  sale_dm_tracking_hit: "売却DMリンク開封",
  // --- 販売図面・その他 ---
  sales_sheet_design_create: "販売図面作成",
  sales_sheet_design_update: "販売図面更新",
  sales_sheet_design_delete: "販売図面削除",
  company_profile_update: "会社情報更新",
  user_delete: "ユーザー削除",
  user_deactivate: "ユーザー無効化",
  user_reactivate: "ユーザー再有効化",
  password_change_self: "パスワード変更(本人)",
  // --- 動的生成 action (三項演算子/ヘルパ経由・@codex R3 で網羅) ---
  postal_code_audit_list: "郵便番号監査一覧",
  postal_code_audit_csv_export: "郵便番号監査CSVエクスポート",
  pii_copy_attempt: "保護画面でのコピー操作",
  pii_cut_attempt: "保護画面での切り取り操作",
  pii_contextmenu_attempt: "保護画面での右クリック",
  pii_print_attempt: "保護画面での印刷操作",
};

const TARGET_TABLE_LABELS: Record<string, string> = {
  properties: "物件",
  owners: "オーナー",
  buildings: "棟",
  users: "ユーザー",
  import_jobs: "インポート",
  permission_templates: "テンプレート",
  user_permissions: "権限",
  property_photos: "写真",
  property_investigation_logs: "調査ログ",
  // B-5(@codex): action 側の日本語化に合わせ、実際に記録される対象テーブル名も
  // 日本語で収載する(未知の値は従来どおり生表示フォールバック)。
  attachments: "添付ファイル",
  building_photos: "棟写真",
  comments: "コメント",
  company_profile: "会社情報",
  dm_campaigns: "売却DMキャンペーン",
  dm_recipient_drafts: "売却DM下書き",
  dm_variants: "売却DM文面",
  field_survey_pin_photos: "調査ピン写真",
  field_survey_pins: "調査ピン",
  field_survey_sessions: "巡回記録",
  field_survey_track_points: "移動軌跡",
  import_job_rows: "取込行",
  next_actions: "次のアクション",
  owner_memos: "オーナーメモ",
  property_dm_logs: "DM履歴",
  property_investigations: "調査情報",
  property_match_candidates: "物件候補",
  property_owners: "所有者紐づけ",
  registry_fetch_config: "謄本取得設定",
  sale_dm_config: "売却DM設定",
  sales_sheet_designs: "販売図面",
  screen_protection: "画面保護",
};

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState<string[]>([]);
  const [targetTables, setTargetTables] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [targetTableFilter, setTargetTableFilter] = useState("");
  // ユーザー名検索: 入力中文字列（即時反映で入力レスポンスを維持）と、fetchLogs が
  // 依存する確定値を分離する。確定値は 300ms debounce 後に更新し、毎キーストロークの
  // /api/admin/audit-logs 再取得を抑制する（F19）。
  const [userNameInput, setUserNameInput] = useState("");
  const [userNameFilter, setUserNameFilter] = useState("");
  const limit = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (actionFilter) params.set("action", actionFilter);
      if (targetTableFilter) params.set("targetTable", targetTableFilter);
      if (userNameFilter) params.set("userName", userNameFilter);
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);

      const res = await fetch(`/api/admin/audit-logs?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `取得に失敗しました (${res.status})`);
      }
      const json = await res.json();
      setLogs(json.data);
      setTotal(json.total);
      if (json.actions) setActions(json.actions);
      if (json.targetTables) setTargetTables(json.targetTables);
    } catch (err) {
      setError(err instanceof Error ? err.message : "監査ログの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [page, actionFilter, targetTableFilter, userNameFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // ユーザー名入力の確定を 300ms debounce する。確定時に page を 1 へ戻し、新しい
  // 検索語で最初のページから取得する。debounce インスタンスは1度だけ生成する。
  const commitUserName = useMemo(
    () =>
      debounce((value: string) => {
        setUserNameFilter(value);
        setPage(1);
      }, 300),
    [],
  );
  // アンマウント時に保留中の debounce を破棄する。
  useEffect(() => () => commitUserName.cancel(), [commitUserName]);

  function handleSearch() {
    // 明示的な「検索」確定: 保留中の debounce を破棄し、入力値を即時反映する。
    commitUserName.cancel();
    setUserNameFilter(userNameInput);
    setPage(1);
  }

  function handleReset() {
    commitUserName.cancel();
    setDateFrom("");
    setDateTo("");
    setActionFilter("");
    setTargetTableFilter("");
    setUserNameInput("");
    setUserNameFilter("");
    setPage(1);
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin" className="hover:text-gray-700 dark:hover:text-gray-300">管理</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">監査ログ</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">監査ログ</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        監査ログは閲覧のみです。編集・削除はできません。
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Filter bar */}
      <div className="mb-6 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="date-from" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              日付範囲（開始）
            </label>
            <input
              id="date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label htmlFor="date-to" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              日付範囲（終了）
            </label>
            <input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label htmlFor="user-name-filter" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              ユーザー名
            </label>
            <input
              id="user-name-filter"
              type="text"
              placeholder="ユーザー名で検索..."
              value={userNameInput}
              onChange={(e) => {
                setUserNameInput(e.target.value);
                commitUserName(e.target.value);
              }}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </div>
          <div>
            <label htmlFor="action-filter" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              操作種別
            </label>
            <select
              id="action-filter"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">すべて</option>
              {actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="target-table-filter" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              対象テーブル
            </label>
            <select
              id="target-table-filter"
              value={targetTableFilter}
              onChange={(e) => setTargetTableFilter(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">すべて</option>
              {targetTables.map((t) => (
                <option key={t} value={t}>{TARGET_TABLE_LABELS[t] ?? t}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={handleSearch}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
            >
              <Search className="h-4 w-4" />
              検索
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <RotateCcw className="h-4 w-4" />
              リセット
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-gray-500" />
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">日時</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">ユーザー</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">操作</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">対象</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800 bg-white dark:bg-gray-900">
              {logs.map((log) => {
                const expanded = expandedId === log.id;
                const hasDetail = log.detail != null;
                return (
                  <Fragment key={log.id}>
                    <tr
                      className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${hasDetail ? "cursor-pointer" : ""}`}
                      onClick={() =>
                        hasDetail && setExpandedId(expanded ? null : log.id)
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono">
                        {formatJaDateTime(log.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {log.user?.name ?? "不明"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm">
                        <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:text-gray-200">
                          {ACTION_LABELS[log.action] ?? log.action}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {log.targetTable && (
                          <span>
                            {TARGET_TABLE_LABELS[log.targetTable] ?? log.targetTable}
                            {log.targetId && (
                              <span className="text-gray-400 dark:text-gray-500 ml-1">#{log.targetId.slice(0, 8)}</span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
                        {hasDetail ? (
                          <span className="text-indigo-600 dark:text-indigo-400">
                            {expanded ? "▼ 折りたたむ" : "▶ 展開"}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                    {expanded && hasDetail && (
                      <tr className="bg-gray-50 dark:bg-gray-800/50">
                        <td colSpan={5} className="px-4 py-3">
                          <pre className="max-h-80 overflow-auto rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 text-xs text-gray-700 dark:text-gray-200">
                            {JSON.stringify(log.detail, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    該当するログが見つかりません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          全 {total} 件{total > 0 && `中 ${(page - 1) * limit + 1}〜${Math.min(page * limit, total)} 件`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            前へ
          </button>
          <span className="flex items-center px-2 text-sm text-gray-500 dark:text-gray-400">
            {page} / {totalPages || 1}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}
