"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import { Loader2 } from "lucide-react";

/**
 * ゴミ箱画面（管理者限定）。
 *
 * GET /api/attachments/trash で削除済み添付一覧を取得し表示する。
 * 謄本は自動削除対象外（お掃除まで「対象外（残す）」）。
 * property スコープの行のみ「元に戻す」で復元できる。
 */

interface TrashItem {
  id: string;
  fileName: string;
  type: "general" | "registry";
  createdAt: string;
  deletedAt: string | null;
  targetType: "property" | "owner" | "comment";
  targetId: string;
}

const RETENTION_DAYS = 90;

const TYPE_LABELS: Record<string, string> = {
  general: "一般",
  registry: "謄本",
};

function daysLeft(deletedAt: string | null, type: TrashItem["type"]): string {
  if (type === "registry") return "対象外（残す）";
  if (!deletedAt) return "-";
  const purgeAt = new Date(deletedAt).getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const left = Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000));
  return left > 0 ? `あと約${left}日` : "まもなくお掃除";
}

export default function AttachmentTrashPage() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/attachments/trash", { signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `一覧の取得に失敗しました (${res.status})`);
      }
      const json = await res.json();
      setItems(json.data ?? []);
      setLoading(false);
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      setError(err instanceof Error ? err.message : "エラーが発生しました");
      setItems([]);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const restore = useCallback(
    async (item: TrashItem) => {
      if (item.targetType !== "property") {
        setError("この添付は現在この画面から復元できません");
        return;
      }
      setBusyId(item.id);
      setError(null);
      try {
        const res = await fetch(
          `/api/properties/${item.targetId}/attachments/${item.id}/restore`,
          { method: "POST" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `復元に失敗しました (${res.status})`);
        }
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "復元に失敗しました");
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin" className="hover:text-gray-700 dark:hover:text-gray-300">
          管理
        </Link>
        <span className="mx-2">/</span>
        <Link href="/admin/attachments" className="hover:text-gray-700 dark:hover:text-gray-300">
          添付ファイル検索
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">ゴミ箱</span>
      </nav>

      <PageHeader
        title="ゴミ箱（削除した添付）"
        description={<>一般の書類は削除から{RETENTION_DAYS}日でお掃除されます。謄本は残ります。期間内は「元に戻す」で復元できます。</>}
      />

      {error && (
        <div className="mb-4 rounded-md border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

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
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  ファイル名
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  種類
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  削除日
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  お掃除まで
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800 bg-white dark:bg-gray-900">
              {items.map((it) => (
                <tr key={it.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100 max-w-xs truncate">
                    {it.fileName}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:text-gray-200">
                      {TYPE_LABELS[it.type] ?? it.type}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono">
                    {it.deletedAt
                      ? new Date(it.deletedAt).toLocaleDateString("ja-JP")
                      : "-"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {daysLeft(it.deletedAt, it.type)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {it.targetType === "property" ? (
                      <button
                        type="button"
                        disabled={busyId === it.id}
                        aria-busy={busyId === it.id}
                        onClick={() => void restore(it)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                      >
                        {busyId === it.id ? "復元中…" : "元に戻す"}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400 dark:text-gray-500">この画面では復元できません</span>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    ゴミ箱は空です。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
