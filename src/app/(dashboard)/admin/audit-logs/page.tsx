"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import Link from "next/link";
import { Loader2, Search, RotateCcw } from "lucide-react";

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
  import_job_mark_failed: "取込を手動失敗化",
  import_job_rollback: "取込ロールバック",
  import_row_resolve: "取込行解決",
  reception_owner_manual_link: "受付帳×所有者の手動紐づけ",
  reception_owner_csv_import: "受付帳×所有者の取込",
  reception_property_csv_import: "受付帳から物件作成",
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

  function handleSearch() {
    setPage(1);
  }

  function handleReset() {
    setDateFrom("");
    setDateTo("");
    setActionFilter("");
    setTargetTableFilter("");
    setUserNameFilter("");
    setPage(1);
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin" className="hover:text-gray-700">管理</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">監査ログ</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">監査ログ</h1>
      <p className="text-sm text-gray-500 mb-6">
        監査ログは閲覧のみです。編集・削除はできません。
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Filter bar */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="date-from" className="block text-xs font-medium text-gray-700 mb-1">
              日付範囲（開始）
            </label>
            <input
              id="date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="date-to" className="block text-xs font-medium text-gray-700 mb-1">
              日付範囲（終了）
            </label>
            <input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="user-name-filter" className="block text-xs font-medium text-gray-700 mb-1">
              ユーザー名
            </label>
            <input
              id="user-name-filter"
              type="text"
              placeholder="ユーザー名で検索..."
              value={userNameFilter}
              onChange={(e) => setUserNameFilter(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="action-filter" className="block text-xs font-medium text-gray-700 mb-1">
              操作種別
            </label>
            <select
              id="action-filter"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">すべて</option>
              {actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="target-table-filter" className="block text-xs font-medium text-gray-700 mb-1">
              対象テーブル
            </label>
            <select
              id="target-table-filter"
              value={targetTableFilter}
              onChange={(e) => setTargetTableFilter(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
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
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            >
              <RotateCcw className="h-4 w-4" />
              リセット
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">日時</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">ユーザー</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">操作</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">対象</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {logs.map((log) => {
                const expanded = expandedId === log.id;
                const hasDetail = log.detail != null;
                return (
                  <Fragment key={log.id}>
                    <tr
                      className={`hover:bg-gray-50 ${hasDetail ? "cursor-pointer" : ""}`}
                      onClick={() =>
                        hasDetail && setExpandedId(expanded ? null : log.id)
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 font-mono">
                        {new Date(log.createdAt).toLocaleString("ja-JP")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                        {log.user?.name ?? "不明"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm">
                        <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                          {ACTION_LABELS[log.action] ?? log.action}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                        {log.targetTable && (
                          <span>
                            {TARGET_TABLE_LABELS[log.targetTable] ?? log.targetTable}
                            {log.targetId && (
                              <span className="text-gray-400 ml-1">#{log.targetId.slice(0, 8)}</span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                        {hasDetail ? (
                          <span className="text-indigo-600">
                            {expanded ? "▼ 折りたたむ" : "▶ 展開"}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                    {expanded && hasDetail && (
                      <tr className="bg-gray-50">
                        <td colSpan={5} className="px-4 py-3">
                          <pre className="max-h-80 overflow-auto rounded border border-gray-200 bg-white p-3 text-xs text-gray-700">
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
                  <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-400">
                    該当するログが見つかりません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          全 {total} 件{total > 0 && `中 ${(page - 1) * limit + 1}〜${Math.min(page * limit, total)} 件`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            前へ
          </button>
          <span className="flex items-center px-2 text-sm text-gray-500">
            {page} / {totalPages || 1}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}
