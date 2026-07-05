"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
  uploadRegistryPdfBulk,
  type RegistryPdfBulkUploadResponse,
} from "@/lib/api-client";
import {
  buildUploadPlan,
  bulkFileKey,
  type BulkFileMeta,
  type ExcludeReason,
  type UploadPlan,
} from "@/lib/registry-pdf-bulk/bulk-upload-plan";
import {
  loadSentKeys,
  recordSentKeys,
  clearSentKeys,
} from "@/lib/registry-pdf-bulk/bulk-upload-resume";

export interface BulkUploadSummary {
  acceptedTotal: number;
  rejectedTotal: number;
  excludedTotal: number;
  batchCount: number;
  jobIds: string[];
}

const REASON_LABEL: Record<ExcludeReason, string> = {
  too_large: "5MB超過",
  not_pdf: "PDF以外",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMetas(files: File[]): BulkFileMeta[] {
  return files.map((f) => ({ name: f.name, size: f.size }));
}

export default function BulkFolderUpload({
  onUploaded,
}: {
  onUploaded?: (summary: BulkUploadSummary) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [batchDone, setBatchDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BulkUploadSummary | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  // webkitdirectory は React の型に無いため callback ref で付与する。
  const folderRefCb = useCallback((el: HTMLInputElement | null) => {
    if (el) el.setAttribute("webkitdirectory", "");
  }, []);

  const onPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const picked = Array.from(input.files ?? []).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    // 同じフォルダ/ファイルを選び直しても onChange が再発火するよう value をクリア。
    input.value = "";
    if (picked.length === 0) return;
    setFiles(picked);
    setPlan(buildUploadPlan(toMetas(picked), loadSentKeys()));
    setSentCount(0);
    setBatchDone(0);
    setError(null);
    setSummary(null);
    setShowExcluded(false);
  }, []);

  const start = useCallback(async () => {
    if (files.length === 0) return;
    // クリック時点の送信済み記録で再計算(中断後は続きから送る)。
    const fresh = buildUploadPlan(toMetas(files), loadSentKeys());
    setPlan(fresh);
    setSentCount(0);
    setBatchDone(0);
    setError(null);
    if (fresh.batches.length === 0) {
      const s: BulkUploadSummary = {
        acceptedTotal: 0,
        rejectedTotal: 0,
        excludedTotal: fresh.excluded.length,
        batchCount: 0,
        jobIds: [],
      };
      setSummary(s);
      onUploaded?.(s);
      return;
    }
    setUploading(true);
    let accepted = 0;
    let rejected = 0;
    let sent = 0;
    const jobIds: string[] = [];
    try {
      for (let b = 0; b < fresh.batches.length; b++) {
        const batch = fresh.batches[b];
        const batchFiles = batch.map((i) => files[i]);
        // 直列送信。503(混雑)や一時失敗に備えた軽いリトライ(最大3回)。
        let res: RegistryPdfBulkUploadResponse | undefined;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            res = await uploadRegistryPdfBulk(batchFiles);
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < 2) await delay(2000);
          }
        }
        if (!res) throw lastErr;
        accepted += res.acceptedCount;
        rejected += res.rejectedCount;
        jobIds.push(res.jobId);
        // 受付拒否(サーバのPDF実体検査/一時保存失敗など)が1件でもあると、
        // どのファイルが拒否されたかは応答(件数のみ)から特定できない。取りこぼしを
        // 避けるため、拒否ゼロのバッチだけ送信済みとして記録する。拒否ありのバッチは
        // 再開時に再送され、受理済みはサーバの請求番号dedупでスキップ、拒否分だけ再試行される。
        if (res.rejectedCount === 0) {
          recordSentKeys(batch.map((i) => bulkFileKey(files[i].name)));
        }
        sent += batch.length;
        setSentCount(sent);
        setBatchDone(b + 1);
      }
      const s: BulkUploadSummary = {
        acceptedTotal: accepted,
        rejectedTotal: rejected,
        excludedTotal: fresh.excluded.length,
        batchCount: fresh.batches.length,
        jobIds,
      };
      setSummary(s);
      onUploaded?.(s);
    } catch (err) {
      setError(
        err instanceof Error
          ? `アップロードを中断しました: ${err.message}（「再開する」で続きから送れます）`
          : "アップロードを中断しました（「再開する」で続きから送れます）",
      );
    } finally {
      setUploading(false);
    }
  }, [files, onUploaded]);

  const reset = useCallback(() => {
    setFiles([]);
    setPlan(null);
    setSentCount(0);
    setBatchDone(0);
    setError(null);
    setSummary(null);
    setShowExcluded(false);
  }, []);

  const clearRecord = useCallback(() => {
    clearSentKeys();
    reset();
  }, [reset]);

  const total = plan?.sendableTotal ?? 0;
  const batchTotal = plan?.batches.length ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((sentCount / total) * 100)) : 0;

  return (
    <div data-bulk-folder-upload className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        「取得済みPDF」フォルダを丸ごと選んでください。100件ずつ自動で分割して順番にアップロードします。件数が多くても放置で完了し、途中で閉じても同じフォルダを選び直せば続きから送れます（送信済みは自動でスキップ）。
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label
          className={`inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white ${
            uploading
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-indigo-700"
          }`}
        >
          フォルダを選択
          <input
            ref={folderRefCb}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            disabled={uploading}
            onChange={onPick}
            className="hidden"
          />
        </label>
        <label
          className={`inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200 ${
            uploading
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
          }`}
        >
          ファイルを選択（複数可）
          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            disabled={uploading}
            onChange={onPick}
            className="hidden"
          />
        </label>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          対応形式: PDF（1ファイル5MBまで）
        </span>
      </div>

      {plan && !summary && (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/40">
          <p className="text-gray-800 dark:text-gray-200">
            選択 {files.length}件 / これから送信{" "}
            <span className="font-semibold">{plan.sendableTotal}件</span>
            {plan.alreadySentCount > 0 &&
              ` / 送信済みスキップ ${plan.alreadySentCount}件`}
            {plan.excluded.length > 0 && ` / 除外 ${plan.excluded.length}件`}
            {plan.batches.length > 0 && `（${plan.batches.length}バッチ）`}
          </p>
          {plan.excluded.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowExcluded((v) => !v)}
                className="text-xs text-indigo-600 underline dark:text-indigo-400"
              >
                除外 {plan.excluded.length}件の内訳を
                {showExcluded ? "隠す" : "見る"}
              </button>
              {showExcluded && (
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-gray-600 dark:text-gray-400">
                  {plan.excluded.map((x) => (
                    <li key={x.index} className="break-all">
                      {REASON_LABEL[x.reason]}: {x.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {(uploading || (sentCount > 0 && !summary)) && (
        <div className="space-y-1">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            送信 {sentCount} / {total}件（バッチ {batchDone} / {batchTotal}）
          </p>
        </div>
      )}

      {plan && plan.batches.length > 0 && !summary && (
        <button
          type="button"
          disabled={uploading}
          onClick={start}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {uploading
            ? "アップロード中..."
            : error
              ? "再開する"
              : "アップロード開始"}
        </button>
      )}

      {plan && plan.batches.length === 0 && !summary && files.length > 0 && (
        plan.alreadySentCount > 0 ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            選択したPDFはすべて送信済みです。
          </p>
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            送信できるPDFがありませんでした（除外 {plan.excluded.length}件）。1ファイル5MB以下のPDFかご確認ください。
          </p>
        )
      )}

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      {summary && (
        <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          <p className="text-emerald-800 dark:text-emerald-300">
            アップロード完了: {summary.acceptedTotal}件を受付
            {summary.batchCount > 0 && `（${summary.batchCount}バッチ）`}
            {summary.excludedTotal > 0 && ` / 除外 ${summary.excludedTotal}件`}
          </p>
          {summary.rejectedTotal > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              受付できなかったファイルが {summary.rejectedTotal}
              件あります(PDFとして読めない等)。取込履歴で確認し、必要なら選び直して再アップロードしてください。
            </p>
          )}
          <p className="text-gray-700 dark:text-gray-300">
            添付結果（添付済 / 既取得スキップ / 要確認）は取込履歴で確認できます。
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/import"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
            >
              取込履歴を見る
            </Link>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              別のフォルダを送る
            </button>
            <button
              type="button"
              onClick={clearRecord}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400"
            >
              送信記録をリセット
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
