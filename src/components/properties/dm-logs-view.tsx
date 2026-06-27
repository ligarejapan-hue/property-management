"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Mail, ChevronLeft, ChevronRight } from "lucide-react";

// GET /api/properties/[id]/dm-logs のレスポンス形（note は server-side でマスク済み）。
interface DmLog {
  id: string;
  sentAt: string;
  method: string | null;
  note: string | null;
  sentBy: { id: string; name: string } | null;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface DmLogsResponse {
  data: DmLog[];
  pagination: Pagination;
}

/**
 * 物件の DM 送付履歴（PropertyDmLog）を read-only で表示する。
 * 認可・PII マスク・監査は GET /api/properties/[id]/dm-logs（サーバ側）が担う。
 * api-client は経由せず直接 fetch する（read-only・本コンポーネント専用のため）。
 */
export default function DmLogsView({ propertyId }: { propertyId: string }) {
  const [logs, setLogs] = useState<DmLog[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/properties/${propertyId}/dm-logs?page=${page}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(
          body?.error?.message ?? "送付履歴の取得に失敗しました",
        );
      }
      const json = (await res.json()) as DmLogsResponse;
      setLogs(json.data);
      setPagination(json.pagination);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "送付履歴の取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [propertyId, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div data-pii-protected data-pii-surface="property">
      <div className="mb-6 flex items-center gap-2">
        <Mail className="h-5 w-5 text-gray-500 dark:text-gray-400" />
        <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">DM 送付履歴</h1>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400 dark:text-gray-500">
          <Mail className="h-8 w-8 mb-2" />
          <p className="text-sm">送付履歴はまだありません</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    送付日
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    方法
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    送信者
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">メモ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {/* sentAt は API が UTC 基準の YYYY-MM-DD で返す（日付のみ・TZ ずれ防止）。 */}
                      {log.sentAt}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.method ?? <span className="text-gray-300 dark:text-gray-600">-</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.sentBy?.name ?? (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                      {log.note ?? <span className="text-gray-300 dark:text-gray-600">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">全 {pagination.total} 件</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex items-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs disabled:opacity-40"
                >
                  <ChevronLeft className="h-3 w-3" />
                  前へ
                </button>
                <span className="text-xs text-gray-600 dark:text-gray-300">
                  {page} / {pagination.totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="flex items-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs disabled:opacity-40"
                >
                  次へ
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
