"use client";

/**
 * 家屋番号チェック（read-only）。
 *
 * 区分建物の全部事項の読み取りの誤り（PR #563 で修正）で、家屋番号に一棟の建物の
 * 「専有部分の家屋番号」（範囲。例 5-1-1 ～ 5-1-43）が入った物件を一覧にする。
 * 候補は物件の最新の謄本を直した読み取りで読み直した値。**ここでは書き換えない**
 * （物件の画面で確かめて直す）。
 */
import { useState, useCallback } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ExternalLink } from "lucide-react";
import {
  fetchBuildingNumberAudit,
  type BuildingNumberAuditResponse,
  type BuildingNumberAuditStatus,
} from "@/lib/api-client";
import { BUILDING_NUMBER_STATUS_LABELS } from "@/lib/building-number-audit";

const STATUS_BADGE: Record<BuildingNumberAuditStatus, string> = {
  suggested: "bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-300",
  no_registry: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  unreadable: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  not_found: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  not_processed: "bg-orange-100 text-orange-700 dark:bg-amber-500/15 dark:text-amber-300",
};

const th = "px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400";

export default function BuildingNumberAuditPage() {
  const [data, setData] = useState<BuildingNumberAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchBuildingNumberAudit());
    } catch (e) {
      setError(e instanceof Error ? e.message : "点検に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  /** 続きから点検する。読み終えた行は残し、未処理の行は続きの結果で置き換える。 */
  const runMore = useCallback(async () => {
    if (!data?.nextCursor && !data?.hasMore) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBuildingNumberAudit(data.nextCursor);
      setData({
        ...next,
        rows: [...data.rows.filter((r) => r.status !== "not_processed"), ...next.rows],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "点検に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [data]);

  const rows = data?.rows ?? [];

  return (
    <div>
      <PageHeader
        title="家屋番号チェック"
        description="家屋番号に建物全体の範囲（例「5-1-1 ～ 5-1-43」）が入っている物件を一覧にします。候補は、物件に添付された最新の謄本を読み直した値です。この画面では書き換えません。物件の画面で謄本と見比べて直してください。"
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={loading} loading={loading} loadingLabel="点検中">
          点検を実行
        </Button>
        {data?.hasMore && (
          <Button variant="secondary" onClick={runMore} disabled={loading}>
            続きを点検
          </Button>
        )}
        {data && (
          <span className="text-sm text-gray-600 dark:text-gray-300">
            対象 {data.total.toLocaleString()}件・候補あり{" "}
            {rows.filter((r) => r.status === "suggested").length.toLocaleString()}件
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>
      )}

      {data && (data.truncated || data.timeBudgetExhausted) && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-orange-50 p-3 text-sm text-orange-800 dark:bg-amber-500/15 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {data.truncated &&
              `対象が多いため、${data.maxTargets.toLocaleString()}件ずつ点検しています。「続きを点検」で残りを点検します。`}
            {data.timeBudgetExhausted &&
              "処理時間の上限に達したため、一部は未処理です。「続きを点検」で続きから点検します。"}
          </span>
        </div>
      )}

      {data && (
        <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800" data-testid="building-number-audit-table">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className={th}>物件</th>
                <th className={th}>今の家屋番号</th>
                <th className={th}>候補（謄本から）</th>
                <th className={th}>状態</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-400 dark:text-gray-500">
                    家屋番号に範囲が入っている物件はありません
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.propertyId}>
                    <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                      <div>{[r.buildingName, r.roomNo].filter(Boolean).join(" ") || "—"}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{r.address}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.buildingNumber}</td>
                    <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{r.suggestion ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>
                        {BUILDING_NUMBER_STATUS_LABELS[r.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/properties/${r.propertyId}`}
                        className="inline-flex items-center gap-1 whitespace-nowrap text-blue-600 hover:underline dark:text-blue-400"
                      >
                        物件を開く
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
