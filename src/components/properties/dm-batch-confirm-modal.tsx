"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Mail, X } from "lucide-react";
import {
  fetchUnconfirmedDmBatches,
  confirmDmBatch,
  type DmBatchSummary,
} from "@/lib/api-client";
import { formatJaDateTime } from "@/lib/format-datetime";

// 送付の確定モーダル(設計書§2.2)。未確定の控え(出力日時・件数)を一覧し、
// 投函日を入れて確定する。宛先(PII)は表示しない。
// 未ダウンロードの控えは確定できない(サーバも 409)ため、バッジ表示+ボタン無効で先に案内する。

/** JST の今日(YYYY-MM-DD)。投函日の既定値・max。 */
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export default function DmBatchConfirmModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [batches, setBatches] = useState<DmBatchSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sentOn, setSentOn] = useState(todayJst());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const fetchBatches = useCallback(async (targetPage = 1, append = false) => {
    setLoading(!append);
    setError(null);
    try {
      const res = await fetchUnconfirmedDmBatches(targetPage);
      setBatches((prev) => (append ? [...prev, ...res.data] : res.data));
      setPage(res.page);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "控えの取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMessage(null);
      setSentOn(todayJst());
      fetchBatches(1, false);
    }
  }, [open, fetchBatches]);

  const handleConfirm = async (batchId: string) => {
    if (confirmingId) return;
    setConfirmingId(batchId);
    setError(null);
    try {
      const res = await confirmDmBatch(batchId, sentOn);
      setMessage(`${res.confirmed}件の送付を記録しました`);
      await fetchBatches(1, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "確定に失敗しました");
    } finally {
      setConfirmingId(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <Mail className="h-5 w-5 text-indigo-500" />
            送付の確定
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          CSVを出力した控えごとに、投函が済んだら日付を入れて確定してください。
          確定すると各物件に送付履歴が記録されます。
        </p>

        <div className="mb-4 flex items-center gap-2">
          <label
            htmlFor="dm-batch-sent-on"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            投函日
          </label>
          <input
            id="dm-batch-sent-on"
            type="date"
            value={sentOn}
            max={todayJst()}
            onChange={(e) => setSentOn(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
          />
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-3 rounded-md border border-green-200 bg-green-50 p-2 text-sm text-green-700 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-400">
            {message}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            読み込み中...
          </div>
        ) : batches.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            未確定の控えはありません
          </div>
        ) : (
          <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-800">
            {batches.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1 text-sm">
                  <div className="text-gray-900 dark:text-gray-100">
                    {formatJaDateTime(b.createdAt)} 出力・{b.rowCount}通
                    {/* 作成者名: admin/office は全員分が並ぶため、誰の控えかを必ず出す(#364 R2)。 */}
                    {b.creatorName && (
                      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                        {b.creatorName}
                      </span>
                    )}
                  </div>
                  {!b.downloadedAt && (
                    <span className="mt-0.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-500/20 dark:text-amber-400">
                      未ダウンロード
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleConfirm(b.id)}
                  disabled={!b.downloadedAt || confirmingId !== null}
                  title={
                    !b.downloadedAt
                      ? "先にCSVをダウンロードしてください"
                      : "この控えの宛先全件を送付済みとして記録"
                  }
                  className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {confirmingId === b.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "確定"
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore && !loading && (
          <button
            type="button"
            onClick={() => fetchBatches(page + 1, true)}
            className="mt-2 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            さらに表示
          </button>
        )}
      </div>
    </div>
  );
}
