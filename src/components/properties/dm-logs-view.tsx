"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, Mail, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { dmMethodLabel, dmTypeLabel } from "@/lib/dm-method-labels";
import { createPropertyDmLog, deletePropertyDmLog } from "@/lib/api-client";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";

// GET /api/properties/[id]/dm-logs のレスポンス形（note は server-side でマスク済み）。
interface DmLog {
  id: string;
  sentAt: string;
  method: string | null;
  dmType: string | null;
  sequence: number;
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

/** JST の今日(YYYY-MM-DD)。投函日の既定値・max。 */
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 個別記録の追加フォーム(next-action-tab の CreateActionForm と同型)。 */
function CreateLogForm({
  propertyId,
  onCreated,
  onCancel,
}: {
  propertyId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [sentOn, setSentOn] = useState(todayJst());
  const [method, setMethod] = useState<"mail" | "hand_delivery" | "other">("mail");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPropertyDmLog(propertyId, {
        sentOn,
        method,
        note: note.trim() ? note.trim() : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "記録の追加に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-500/40 dark:bg-blue-500/20"
    >
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-sm text-gray-700 dark:text-gray-200">
          投函日
          <input
            type="date"
            value={sentOn}
            max={todayJst()}
            onChange={(e) => setSentOn(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-200">
          方法
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as "mail" | "hand_delivery" | "other")
            }
            className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="mail">郵送</option>
            <option value="hand_delivery">手渡し</option>
            <option value="other">その他</option>
          </select>
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-200">
          メモ(任意)
          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例: 挨拶を兼ねて手渡し"
            className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={submitting || !sentOn}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "記録中..." : "記録する"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}

/**
 * 物件の DM 送付履歴（PropertyDmLog）を表示し、個別の記録・取消を行う(PR-A)。
 * 認可・PII マスク・監査は API(サーバ側)が担う。閲覧は直接 fetch(read-only 専用)、
 * 書き込み(追加/取消)は api-client 経由(USE_MOCK 分岐込み)。
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
  const [showForm, setShowForm] = useState(false);

  // 追加/取消は property:write を要求(サーバも 403)。押しても必ず失敗するUIを出さない。
  const { permissions, permissionsLoading } = useScreenProtection();
  const canWrite = useMemo(() => {
    if (permissionsLoading) return false;
    return (permissions ?? []).some(
      (p) => p.resource === "property" && p.action === "write" && p.granted,
    );
  }, [permissions, permissionsLoading]);

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

  const handleDelete = async (logId: string) => {
    if (!window.confirm("この送付記録を取り消しますか？")) return;
    try {
      await deletePropertyDmLog(propertyId, logId);
      // ページの最後の1件を消したら前のページへ戻る(#364 R4: 範囲外ページの再取得は
      // 空配列になり「送付履歴はまだありません」に取り残される)。setPage が再取得を起こす。
      if (logs.length === 1 && page > 1) {
        setPage((p) => Math.max(1, p - 1));
      } else {
        fetchLogs();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消に失敗しました");
    }
  };

  return (
    <div data-pii-protected data-pii-surface="property">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">DM 送付履歴</h1>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            記録を追加
          </button>
        )}
      </div>

      {showForm && (
        <CreateLogForm
          propertyId={propertyId}
          onCreated={() => {
            setShowForm(false);
            fetchLogs();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

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
                    何通目
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    方法
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    種別
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium text-gray-600 dark:text-gray-300">
                    送信者
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-600 dark:text-gray-300">メモ</th>
                  {canWrite && <th className="w-10 px-2 py-2" aria-label="操作" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {/* sentAt は API が UTC 基準の YYYY-MM-DD で返す（日付のみ・TZ ずれ防止）。 */}
                      {log.sentAt}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {log.sequence > 0 ? `${log.sequence}通目` : "-"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.method ? (
                        dmMethodLabel(log.method)
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.dmType ? (
                        dmTypeLabel(log.dmType)
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {log.sentBy?.name ?? (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                      {log.note ?? <span className="text-gray-300 dark:text-gray-600">-</span>}
                    </td>
                    {canWrite && (
                      <td className="px-2 py-2">
                        {/* 売却DM由来の行はサーバが 409 で拒否するため、取消ボタン自体を出さない。 */}
                        {log.method !== "sale_dm" && (
                          <button
                            type="button"
                            onClick={() => handleDelete(log.id)}
                            className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:text-gray-500 dark:hover:bg-red-500/10"
                            title="この記録を取り消す"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    )}
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
