"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, Search, RotateCcw } from "lucide-react";

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

  const fetchResults = useCallback(async () => {
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

      const res = await fetch(`/api/attachments/search?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `取得に失敗しました (${res.status})`);
      }
      const json = await res.json();
      setResults(json.data ?? []);
      setCount(json.count ?? json.data?.length ?? 0);
      setLimit(json.limit ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "検索に失敗しました");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [applied]);

  // 初回 + applied 確定時のみ取得（入力中は再取得しない）。
  useEffect(() => {
    void fetchResults();
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
    <div className="min-h-screen bg-gray-50 p-6">
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin" className="hover:text-gray-700">
          管理
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">添付横断検索</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">添付横断検索</h1>
      <p className="text-sm text-gray-500 mb-6">
        添付のメタデータ（ファイル名・種別・対象・登録日時）のみを横断検索します。
        ファイル本体のダウンロードはこの画面では提供しません。
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
            <label htmlFor="file-name" className="block text-xs font-medium text-gray-700 mb-1">
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
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="type-filter" className="block text-xs font-medium text-gray-700 mb-1">
              種別
            </label>
            <select
              id="type-filter"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">すべて</option>
              <option value="general">一般</option>
              <option value="registry">謄本</option>
            </select>
          </div>
          <div>
            <label htmlFor="target-type-filter" className="block text-xs font-medium text-gray-700 mb-1">
              対象種別
            </label>
            <select
              id="target-type-filter"
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">すべて</option>
              <option value="property">物件</option>
              <option value="owner">所有者</option>
              <option value="comment">コメント</option>
            </select>
          </div>
          <div>
            <label htmlFor="target-id" className="block text-xs font-medium text-gray-700 mb-1">
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
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="date-from" className="block text-xs font-medium text-gray-700 mb-1">
              登録日（開始）
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
              登録日（終了）
            </label>
            <input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
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
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  登録日時
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  ファイル名
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  種別
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  対象
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {results.map((hit) => (
                <tr key={hit.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 font-mono">
                    {new Date(hit.createdAt).toLocaleString("ja-JP")}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-md truncate">
                    {hit.fileName}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                      {TYPE_LABELS[hit.type] ?? hit.type}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                    {TARGET_TYPE_LABELS[hit.targetType] ?? hit.targetType}
                    <span className="text-gray-400 ml-1">#{hit.targetId.slice(0, 8)}</span>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-400">
                    該当する添付が見つかりません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-sm text-gray-500">
        {count} 件
        {limit > 0 && count >= limit && (
          <span className="text-amber-600">
            （上限 {limit} 件まで表示。条件を絞ってください）
          </span>
        )}
      </p>
    </div>
  );
}
