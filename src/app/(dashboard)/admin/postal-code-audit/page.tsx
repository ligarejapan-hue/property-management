"use client";

import { useState, useCallback } from "react";
import { Loader2, MapPinned, Download, AlertTriangle } from "lucide-react";
import {
  fetchPostalCodeAudit,
  type PostalCodeAuditResponse,
  type PostalAuditRowDTO,
  type PostalAuditVerdict,
} from "@/lib/api-client";
// reason → ラベルは共有マップ（型 Record で not_processed を含む全 reason を網羅保証）を使う。
// ローカルで別マップを再定義すると not_processed 等の取りこぼし（『判定不能（undefined）』）が
// 再発するため、必ず共有マップを参照する（Codex P2）。
import { INDETERMINATE_REASON_LABELS } from "@/lib/postal-code-audit";

const VERDICT_LABELS: Record<PostalAuditVerdict, string> = {
  match: "一致",
  mismatch: "不一致",
  indeterminate: "判定不能",
};

const VERDICT_BADGE: Record<PostalAuditVerdict, string> = {
  match: "bg-green-100 text-green-700",
  mismatch: "bg-red-100 text-red-700",
  indeterminate: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

const REASON_LABELS = INDETERMINATE_REASON_LABELS;

// not_processed（時間バジェット超過の未処理）は verdict=indeterminate だが、
// 「判定不能」ではなく未処理として明示するため別タブ・別バッジで扱う。
type VerdictFilter = "all" | PostalAuditVerdict | "not_processed";

/** not_processed 行か（verdict は indeterminate だが UI では未処理として独立扱い）。 */
function isNotProcessed(r: PostalAuditRowDTO): boolean {
  return r.reason === "not_processed";
}

const FILTER_TABS: { key: VerdictFilter; label: string }[] = [
  { key: "mismatch", label: "不一致" },
  { key: "indeterminate", label: "判定不能" },
  { key: "not_processed", label: "未処理" },
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
    filter === "all"
      ? rows
      : filter === "not_processed"
        ? // 未処理（時間上限）だけを抽出。
          rows.filter(isNotProcessed)
        : filter === "indeterminate"
          ? // 判定不能タブは未処理（not_processed）を含めない（別タブで明示する）。
            rows.filter((r) => r.verdict === "indeterminate" && !isNotProcessed(r))
          : rows.filter((r) => r.verdict === filter);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <MapPinned className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">郵便番号×住所 整合チェック</h1>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
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
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Download className="h-4 w-4" />
            CSV出力
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>
      )}

      {data && !data.apiConfigured && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-yellow-50 p-3 text-sm text-yellow-800 dark:bg-amber-500/15 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            住所APIが未設定のため照合できません。すべての所有者が「判定不能（API照合不可）」になります。
          </span>
        </div>
      )}

      {data && data.truncated && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-orange-50 p-3 text-sm text-orange-800 dark:bg-amber-500/15 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            対象が上限（{data.maxTargets.toLocaleString()}件）に達したため、先頭
            {data.maxTargets.toLocaleString()}件のみを点検しました。残りは未点検です。
          </span>
        </div>
      )}

      {data && data.timeBudgetExhausted && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-orange-50 p-3 text-sm text-orange-800 dark:bg-amber-500/15 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            処理時間の上限（{Math.round(data.timeBudgetMs / 1000)}秒）に達したため、
            {data.notProcessed.toLocaleString()}件が未処理（時間上限）です。
            未処理分はもう一度「照合を実行」するか、対象を絞って再実行してください。
            （照合済み {data.processed.toLocaleString()}件）
          </span>
        </div>
      )}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap gap-4 text-sm">
            <span className="text-gray-600 dark:text-gray-300">
              対象 <strong className="text-gray-900 dark:text-gray-100">{data.summary.total}</strong>
            </span>
            <span className="text-green-700 dark:text-green-400">
              一致 <strong>{data.summary.match}</strong>
            </span>
            <span className="text-red-700 dark:text-red-400">
              不一致 <strong>{data.summary.mismatch}</strong>
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              {/* route の summary.indeterminate は未処理(not_processed)も含むため、
                  「判定不能」表示は未処理を除いた数にして未処理タブと整合させる。 */}
              判定不能 <strong>{data.summary.indeterminate - data.notProcessed}</strong>
            </span>
            {data.notProcessed > 0 && (
              <span className="text-orange-700 dark:text-orange-400">
                未処理 <strong>{data.notProcessed}</strong>
              </span>
            )}
          </div>

          <div className="mb-3 flex gap-1 border-b border-gray-200 dark:border-gray-800">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`px-3 py-2 text-sm font-medium ${
                  filter === tab.key
                    ? "border-b-2 border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-400"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">所有者</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">保存郵便番号</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">保存住所</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">API住所</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">判定</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-900">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-gray-400 dark:text-gray-500">
                      該当する所有者はありません
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((r) => (
                    <tr key={r.ownerId}>
                      <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{r.nameMasked ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.zipMasked ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.addressMasked ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{r.apiAddressLine ?? "—"}</td>
                      <td className="px-3 py-2">
                        {isNotProcessed(r) ? (
                          // 未処理(時間上限): verdict は indeterminate だが「判定不能」とは
                          // 別物として専用ラベル・専用バッジで明示する（Codex P2）。
                          <span className="inline-block rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                            {REASON_LABELS.not_processed}
                          </span>
                        ) : (
                          <span
                            className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${VERDICT_BADGE[r.verdict]}`}
                          >
                            {VERDICT_LABELS[r.verdict]}
                            {r.reason ? `（${REASON_LABELS[r.reason]}）` : ""}
                          </span>
                        )}
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
        <p className="text-sm text-gray-400 dark:text-gray-500">
          「照合を実行」を押すと、所有者の郵便番号と住所をAPIで点検します。
        </p>
      )}
    </div>
  );
}
