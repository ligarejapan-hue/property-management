"use client";

import { useState, useEffect, useCallback } from "react";
import {
  fetchOwnerCorrectionCandidates,
  type OwnerCorrectionCandidate,
  type OwnerCorrectionCandidatesResponse,
} from "@/lib/api-client";

type FilterType = "all" | "orphan" | "address_null" | "duplicate";

const TYPE_LABELS: Record<string, string> = {
  orphan: "孤立",
  address_null: "住所なし",
  duplicate: "重複候補",
};

const TYPE_BADGE: Record<string, string> = {
  orphan: "bg-orange-100 text-orange-700",
  address_null: "bg-yellow-100 text-yellow-700",
  duplicate: "bg-purple-100 text-purple-700",
};

const ACTION_LABELS: Record<string, string> = {
  hold: "保留",
  review: "要確認",
  delete_candidate: "削除候補",
  merge_candidate: "統合候補",
};

const ACTION_BADGE: Record<string, string> = {
  hold: "bg-gray-100 text-gray-500",
  review: "bg-blue-100 text-blue-700",
  delete_candidate: "bg-red-100 text-red-700",
  merge_candidate: "bg-purple-100 text-purple-700",
};

const BLOCK_REASON_LABELS: Record<string, string> = {
  property_owner_exists: "物件紐づきあり",
  changelog_exists: "変更履歴あり",
  version_gt_1: "手動編集あり",
  external_link_key_exists: "外部キーあり",
  note_exists: "メモあり",
  import_source_unknown: "取込元不明",
  import_row_not_success: "取込行未解決",
};

export default function OwnerCorrectionPage() {
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [data, setData] = useState<OwnerCorrectionCandidatesResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (type: FilterType) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOwnerCorrectionCandidates(type);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filterType);
  }, [filterType, load]);

  const tabs: { key: FilterType; label: string; count?: number }[] = [
    { key: "all", label: "全て", count: data?.summary.allCount },
    { key: "orphan", label: "孤立", count: data?.summary.orphanCount },
    {
      key: "address_null",
      label: "住所なし",
      count: data?.summary.addressNullCount,
    },
    {
      key: "duplicate",
      label: "重複候補",
      count: data?.summary.duplicateCount,
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-1">
        <h1 className="text-xl font-bold text-gray-900">
          所有者補正候補 (dry-run)
        </h1>
      </div>
      <p className="mb-6 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
        確認専用画面です。この画面からデータベースを変更することはできません。
      </p>

      {/* Filter tabs */}
      <div className="mb-4 flex gap-0 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilterType(tab.key)}
            className={`-mb-px px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              filterType === tab.key
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && (
        <p className="py-8 text-center text-sm text-gray-400">読み込み中...</p>
      )}
      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {data && !loading && (
        <>
          <p className="mb-3 text-sm text-gray-500">
            {data.total} 件の確認候補
          </p>

          {data.candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              該当する候補はありません
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">氏名</th>
                    <th className="px-3 py-2 text-left font-medium">住所</th>
                    <th className="px-3 py-2 text-left font-medium">
                      郵便番号
                    </th>
                    <th className="px-3 py-2 text-left font-medium">電話</th>
                    <th className="px-3 py-2 text-center font-medium">
                      紐づき数
                    </th>
                    <th className="px-3 py-2 text-center font-medium">
                      変更履歴
                    </th>
                    <th className="px-3 py-2 text-center font-medium">ver</th>
                    <th className="px-3 py-2 text-left font-medium">取込元</th>
                    <th className="px-3 py-2 text-left font-medium">種別</th>
                    <th className="px-3 py-2 text-left font-medium">
                      ブロック理由
                    </th>
                    <th className="px-3 py-2 text-left font-medium">推奨</th>
                    <th className="px-3 py-2 text-left font-medium">ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.candidates.map((c: OwnerCorrectionCandidate) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {c.name ?? (
                          <span className="text-gray-400">***</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.address ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.zip ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {c.phone ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={
                            c.propertyOwnerCount === 0
                              ? "font-medium text-orange-600"
                              : "text-gray-700"
                          }
                        >
                          {c.propertyOwnerCount}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-gray-700">
                        {c.changeLogCount}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-700">
                        {c.version}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-500">
                        {c.importFileName ? (
                          `${c.importFileName}:${c.importRowNumber}行`
                        ) : (
                          <span className="text-gray-400">不明</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.types.map((t) => (
                            <span
                              key={t}
                              className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
                                TYPE_BADGE[t] ?? "bg-gray-100 text-gray-600"
                              }`}
                            >
                              {TYPE_LABELS[t] ?? t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {c.blockReasons.map((r) => (
                            <span
                              key={r}
                              className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500"
                            >
                              {BLOCK_REASON_LABELS[r] ?? r}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            ACTION_BADGE[c.recommendedAction] ??
                            "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {ACTION_LABELS[c.recommendedAction] ??
                            c.recommendedAction}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-gray-400">
                        {c.id.slice(0, 8)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 text-xs text-gray-400">
            ※ 削除・統合・再リンクの実行機能はこの画面には実装していません。
          </p>
        </>
      )}
    </div>
  );
}
