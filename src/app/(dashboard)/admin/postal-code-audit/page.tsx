"use client";

import { useState, useCallback } from "react";
import { Loader2, MapPinned, Download, AlertTriangle } from "lucide-react";
import {
  fetchPostalCodeAudit,
  type PostalCodeAuditResponse,
  type PostalAuditRowDTO,
  type PostalAuditVerdict,
  type PostalAuditIndeterminateReason,
} from "@/lib/api-client";

const VERDICT_LABELS: Record<PostalAuditVerdict, string> = {
  match: "一致",
  mismatch: "不一致",
  indeterminate: "判定不能",
};

const VERDICT_BADGE: Record<PostalAuditVerdict, string> = {
  match: "bg-green-100 text-green-700",
  mismatch: "bg-red-100 text-red-700",
  indeterminate: "bg-gray-100 text-gray-600",
};

const REASON_LABELS: Record<PostalAuditIndeterminateReason, string> = {
  invalid_postal_code: "郵便番号が不正",
  address_empty: "住所が空",
  no_candidate: "該当住所なし",
  lookup_unavailable: "API照合不可",
};

type VerdictFilter = "all" | PostalAuditVerdict;

const FILTER_TABS: { key: VerdictFilter; label: string }[] = [
  { key: "mismatch", label: "不一致" },
  { key: "indeterminate", label: "判定不能" },
  { key: "match", label: "一致" },
  { key: "all", label: "すべて" },
];

export default function PostalCodeAuditPage() {
  const [data, setData] = useState<PostalCodeAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VerdictFilter>("mismatch");

  const runAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPostalCodeAudit();
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "照合に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCsvDownload = useCallback(() => {
    // CSV は別ゲート(csv_export 系)。ブラウザ遷移でそのままダウンロードさせる。
    window.location.href = "/api/admin/postal-code-audit?format=csv";
  }, []);

  const rows: PostalAuditRowDTO[] = data?.rows ?? [];
  const filteredRows =
    filter === "all" ? rows : rows.filter((r) => r.verdict === filter);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <MapPinned className="h-6 w-6 text-indigo-600" />
        <h1 className="text-xl font-bold text-gray-900">郵便番号×住所 整合チェック</h1>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-gray-600">
        所有者の保存済み郵便番号を住所APIと突き合わせ、保存住所と整合しているかを点検します。
        このレポートは閲覧のみで、データの自動修正は行いません。外部APIへ送信するのは郵便番号のみです。
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={runAudit}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loading ? "照合中..." : "照合を実行"}
        </button>
        {data && (
          <button
            onClick={handleCsvDownload}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-4 w-4" />
            CSV出力
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {data && !data.apiConfigured && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            住所APIが未設定のため照合できません。すべての所有者が「判定不能（API照合不可）」になります。
          </span>
        </div>
      )}

      {data && data.truncated && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-orange-50 p-3 text-sm text-orange-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            対象が上限（{data.maxTargets.toLocaleString()}件）に達したため、先頭
            {data.maxTargets.toLocaleString()}件のみを点検しました。残りは未点検です。
          </span>
        </div>
      )}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap gap-4 text-sm">
            <span className="text-gray-600">
              対象 <strong className="text-gray-900">{data.summary.total}</strong>
            </span>
            <span className="text-green-700">
              一致 <strong>{data.summary.match}</strong>
            </span>
            <span className="text-red-700">
              不一致 <strong>{data.summary.mismatch}</strong>
            </span>
            <span className="text-gray-600">
              判定不能 <strong>{data.summary.indeterminate}</strong>
            </span>
          </div>

          <div className="mb-3 flex gap-1 border-b border-gray-200">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`px-3 py-2 text-sm font-medium ${
                  filter === tab.key
                    ? "border-b-2 border-indigo-600 text-indigo-700"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">所有者</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">保存郵便番号</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">保存住所</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">API住所</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">判定</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                      該当する所有者はありません
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((r) => (
                    <tr key={r.ownerId}>
                      <td className="px-3 py-2 text-gray-900">{r.nameMasked ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700">{r.zipMasked ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700">{r.addressMasked ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700">{r.apiAddressLine ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${VERDICT_BADGE[r.verdict]}`}
                        >
                          {VERDICT_LABELS[r.verdict]}
                          {r.reason ? `（${REASON_LABELS[r.reason]}）` : ""}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!data && !loading && (
        <p className="text-sm text-gray-400">
          「照合を実行」を押すと、所有者の郵便番号と住所をAPIで点検します。
        </p>
      )}
    </div>
  );
}
