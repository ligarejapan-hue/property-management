"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

interface PermissionLog {
  id: string;
  targetUserId: string;
  changedBy: string;
  changeType: string;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
  targetUser: { id: string; name: string | null };
  changer: { id: string; name: string | null };
}

const CHANGE_TYPE_LABELS: Record<string, string> = {
  override_update: "個別権限更新",
  role_change: "ロール変更",
  template_apply: "テンプレート適用",
};

const CHANGE_TYPE_COLORS: Record<string, string> = {
  override_update: "bg-blue-100 text-blue-800",
  role_change: "bg-purple-100 text-purple-800",
  template_apply: "bg-green-100 text-green-800",
};

export default function PermissionLogsPage() {
  const [logs, setLogs] = useState<PermissionLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const limit = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      const res = await fetch(`/api/admin/permission-logs?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setLogs(json.data);
      setTotal(json.total);
    } catch {
      console.error("Failed to fetch permission logs");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin" className="hover:text-gray-700">管理</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">権限変更履歴</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">権限変更履歴</h1>

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
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">操作者</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">対象ユーザー</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">変更種別</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">変更内容</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 font-mono">
                    {new Date(log.createdAt).toLocaleString("ja-JP")}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                    {log.changer?.name ?? "不明"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                    {log.targetUser?.name ?? "不明"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        CHANGE_TYPE_COLORS[log.changeType] ?? "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {CHANGE_TYPE_LABELS[log.changeType] ?? log.changeType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 max-w-md">
                    <ChangeDetail oldValue={log.oldValue} newValue={log.newValue} />
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-400">
                    権限変更履歴がありません。
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

function ChangeDetail({ oldValue, newValue }: { oldValue: unknown; newValue: unknown }) {
  if (!oldValue && !newValue) return <span className="text-gray-400">—</span>;

  const oldArr = Array.isArray(oldValue) ? oldValue : [];
  const newArr = Array.isArray(newValue) ? newValue : [];

  const added = newArr.filter(
    (n: { resource: string; action: string }) =>
      !oldArr.some((o: { resource: string; action: string }) => o.resource === n.resource && o.action === n.action),
  );
  const removed = oldArr.filter(
    (o: { resource: string; action: string }) =>
      !newArr.some((n: { resource: string; action: string }) => n.resource === o.resource && n.action === o.action),
  );

  if (added.length === 0 && removed.length === 0) {
    return <span className="text-gray-400">変更なし</span>;
  }

  return (
    <div className="space-y-1">
      {added.map((p: { resource: string; action: string }, i: number) => (
        <span key={`add-${i}`} className="inline-flex mr-1 rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">
          +{p.resource}:{p.action}
        </span>
      ))}
      {removed.map((p: { resource: string; action: string }, i: number) => (
        <span key={`rm-${i}`} className="inline-flex mr-1 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
          -{p.resource}:{p.action}
        </span>
      ))}
    </div>
  );
}
