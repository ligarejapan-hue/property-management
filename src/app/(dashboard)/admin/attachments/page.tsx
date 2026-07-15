"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, Search, RotateCcw } from "lucide-react";
import { formatJaDateTime } from "@/lib/format-datetime";

/**
 * 添付横断検索（管理者限定）。
 *
 * GET /api/attachments/search を直接叩き（api-client 非経由）、メタデータのみを
 * 一覧表示する。ファイル本体 URL は API が返さないため、この画面でもダウンロード
 * 導線は提供しない（所在把握用。実体の閲覧は物件詳細など本来の権限導線で）。
 */

interface AttachmentHit {
  id: string;
  fileName: string;
  type: string;
  createdAt: string;
  targetType: string;
  targetId: string;
}

interface Filters {
  type: string;
  fileName: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  type: "",
  fileName: "",
  targetType: "",
  targetId: "",
  from: "",
  to: "",
};

const TYPE_LABELS: Record<string, string> = {
  general: "一般",
  registry: "謄本",
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  property: "物件",
  owner: "所有者",
  comment: "コメント",
};

export default function AttachmentSearchPage() {
  const [results, setResults] = useState<AttachmentHit[]>([]);
  const [count, setCount] = useState(0);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 入力中の値（即時反映）と、実際に検索へ適用する値（「検索」押下で確定）を分離し、
  // キーストロークごとの再取得を避ける。
  const [type, setType] = useState("");
  const [fileName, setFileName] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const fetchResults = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (applied.type) params.set("type", applied.type);
        if (applied.fileName.trim()) params.set("fileName", applied.fileName.trim());
        if (applied.targetType) params.set("targetType", applied.targetType);
        if (applied.targetId.trim()) params.set("targetId", applied.targetId.trim());
        if (applied.from) params.set("from", applied.from);
        if (applied.to) params.set("to", applied.to);

        const res = await fetch(`/api/attachments/search?${params}`, { signal });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `取得に失敗しました (${res.status})`);
        }
        const json = await res.json();
        setResults(json.data ?? []);
        setCount(json.count ?? json.data?.length ?? 0);
        setLimit(json.limit ?? 0);
        setLoading(false);
      } catch (err) {
        // 後発リクエストに置き換えられた古い fetch（abort 済み）は state を触らない。
        // loading も解除しない（最新リクエストが進行中のため）。
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setError(err instanceof Error ? err.message : "検索に失敗しました");
        setResults([]);
        setLoading(false);
      }
    },
    [applied],
  );

  // 初回 + applied 確定時のみ取得（入力中は再取得しない）。filter 変更で前リクエストを
  // abort し、遅延した古いレスポンスが新しい結果を上書きしないようにする。
  useEffect(() => {
    const controller = new AbortController();
    void fetchResults(controller.signal);
    return () => controller.abort();
  }, [fetchResults]);

  function handleSearch() {
    setApplied({ type, fileName, targetType, targetId, from: dateFrom, to: dateTo });
  }

  function handleReset() {
    setType("");
    setFileName("");
    setTargetType("");
    setTargetId("");
    setDateFrom("");
    setDateTo("");
    setApplied(EMPTY_FILTERS);
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <nav className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        <Link href="/admin" className="hover:text-gray-700 dark:hover:text-gray-300">
          管理
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900 dark:text-gray-100">添付横断検索</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">添付横断検索</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        添付のメタデータ（ファイル名・種別・対象・登録日時）のみを横断検索します。
        ファイル本体のダウンロードはこの画面では提供しません。
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
            <label htmlFor="file-name" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              ファイル名（部分一致）
            </label>
            <input
              id="file-name"
              type="text"
              placeholder="ファイル名で検索..."
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </div>
          <div>
            <label htmlFor="type-filter" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              種別
            </label>
            <select
              id="type-filter"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">すべて</option>
              <option value="general">一般</option>
              <option value="registry">謄本</option>
            </select>
          </div>
          <div>
            <label htmlFor="target-type-filter" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              対象種別
            </label>
            <select
              id="target-type-filter"
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">すべて</option>
              <option value="property">物件</option>
              <option value="owner">所有者</option>
              <option value="comment">コメント</option>
            </select>
          </div>
          <div>
            <label htmlFor="target-id" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              対象 ID（任意）
            </label>
            <input
              id="target-id"
              type="text"
              placeholder="対象の ID（UUID）"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </div>
          <div>
            <label htmlFor="date-from" className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
              登録日（開始）
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
              登録日（終了）
            </label>
            <input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-900 dark:text-gray-100"
            />
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
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  登録日時
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  ファイル名
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  種別
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  対象
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800 bg-white dark:bg-gray-900">
              {results.map((hit) => (
                <tr key={hit.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono">
                    {formatJaDateTime(hit.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100 max-w-md truncate">
                    {hit.fileName}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:text-gray-200">
                      {TYPE_LABELS[hit.type] ?? hit.type}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {TARGET_TYPE_LABELS[hit.targetType] ?? hit.targetType}
                    <span className="text-gray-400 dark:text-gray-500 ml-1">#{hit.targetId.slice(0, 8)}</span>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    該当する添付が見つかりません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
        {count} 件
        {limit > 0 && count >= limit && (
          <span className="text-amber-600 dark:text-amber-400">
            （上限 {limit} 件まで表示。条件を絞ってください）
          </span>
        )}
      </p>
    </div>
  );
}
