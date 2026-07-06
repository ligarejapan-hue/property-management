"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import ImportSwitcher from "@/components/import/import-switcher";
import BulkFolderUpload, {
  type BulkUploadSummary,
} from "@/components/import/bulk-folder-upload";
import FilePickerButton from "@/components/import/file-picker-button";
import {
  readFileForImport,
  previewReceptionPropertyCsv,
  importReceptionPropertyCsv,
  previewReceptionOwnerCsv,
  importReceptionOwnerCsv,
  type ReceptionPropertyPreviewResponse,
  type ReceptionPropertyImportResponse,
  type ReceptionOwnerPreviewResponse,
  type ReceptionOwnerImportResponse,
  type ReceptionDlFilter,
  type ReceptionShinkiFilter,
} from "@/lib/api-client";

// ============================================================
// 登記DM取込ウィザード
// ------------------------------------------------------------
// 外部ツール(不動産登記情報自動化システム)の成果物を順に取り込む:
//   ①受付帳Excel → 物件作成(既存API)
//   ②受付帳×所有者Excel → 所有者登録+紐付け(既存API)
//   ③取得済み所有者事項PDF → 一括アップロード(非同期ジョブ・閉じてもOK)
//   ④結果サマリ → 売却DMへの導線
// 各ステップは独立(途中から/一部だけでも使える)。
// ============================================================

// readFileForImport の実戻り値は { fileName, csvText?, xlsxBase64? }
// (api-client.ts 実物のプロパティ名は fileName であり name ではない)。
type SheetFile = { fileName: string; csvText?: string; xlsxBase64?: string };

const STEPS = [
  { n: 1, title: "受付帳Excel(物件作成)" },
  { n: 2, title: "所有者Excel(所有者登録)" },
  { n: 3, title: "取得済みPDF(謄本添付)" },
  { n: 4, title: "結果" },
] as const;

export default function RegistryDmImportPage() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // --- step1: 受付帳→物件 ---
  const [rpFile, setRpFile] = useState<SheetFile | null>(null);
  const [rpDl, setRpDl] = useState<ReceptionDlFilter>("marked");
  // 既存単独画面(import/page.tsx の rpShinkiFilter)の既定値に合わせる("existing")。
  const [rpShinki, setRpShinki] = useState<ReceptionShinkiFilter>("existing");
  const [rpPreview, setRpPreview] =
    useState<ReceptionPropertyPreviewResponse | null>(null);
  const [rpResult, setRpResult] =
    useState<ReceptionPropertyImportResponse | null>(null);

  // --- step2: 受付帳×所有者 ---
  const [ownerFile, setOwnerFile] = useState<SheetFile | null>(null);
  const [roDl, setRoDl] = useState<ReceptionDlFilter>("marked");
  const [roShinki, setRoShinki] = useState<ReceptionShinkiFilter>("existing");
  const [roPreview, setRoPreview] =
    useState<ReceptionOwnerPreviewResponse | null>(null);
  const [roResult, setRoResult] =
    useState<ReceptionOwnerImportResponse | null>(null);

  // --- step3: PDF一括 ---
  const [bulkSummary, setBulkSummary] = useState<BulkUploadSummary | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div data-pii-protected data-pii-surface="import" className="space-y-6">
      <ImportSwitcher />
      <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
        登記DM取込
      </h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        登記情報自動化ツールの成果物(受付帳Excel・所有者Excel・取得済みPDF)を順に取り込みます。各ステップは独立しているので、必要なものだけ実行しても構いません。
      </p>

      {/* ステップナビ */}
      <ol className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((s) => (
          <li key={s.n}>
            <button
              type="button"
              onClick={() => setStep(s.n as typeof step)}
              aria-current={step === s.n ? "step" : undefined}
              className={`rounded-full border px-3 py-1 ${
                step === s.n
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {s.n}. {s.title}
            </button>
          </li>
        ))}
      </ol>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ---------- Step 1 ---------- */}
      {step === 1 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ① 受付帳Excelから物件を作成
          </h2>
          <FilePickerButton
            accept=".xlsx,.csv"
            label="受付帳を選択"
            hint="Excel(.xlsx) または CSV"
            fileName={rpFile?.fileName ?? null}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              await run(async () => {
                setRpFile(await readFileForImport(f));
                setRpPreview(null);
                setRpResult(null);
                // ②(所有者Excel)は①と同じ受付帳ファイルを使うため、こちらの
                // プレビュー/結果も古いファイルのままにしない(step2側の対称対応)。
                setRoPreview(null);
                setRoResult(null);
              });
            }}
          />
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              DL列:
              <select
                value={rpDl}
                onChange={(e) => {
                  setRpDl(e.target.value as ReceptionDlFilter);
                  setRpPreview(null);
                  setRpResult(null);
                }}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="marked">〇のみ</option>
                <option value="unmarked">〇なしのみ</option>
                <option value="all">すべて</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              新既:
              <select
                value={rpShinki}
                onChange={(e) => {
                  setRpShinki(e.target.value as ReceptionShinkiFilter);
                  setRpPreview(null);
                  setRpResult(null);
                }}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="all">すべて</option>
                <option value="new">新規のみ</option>
                <option value="existing">既存のみ</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!rpFile || loading}
              onClick={() =>
                run(async () => {
                  setRpPreview(
                    await previewReceptionPropertyCsv({
                      receptionFileName: rpFile!.fileName,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      dlFilter: rpDl,
                      shinkiFilter: rpShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              プレビュー
            </button>
            <button
              type="button"
              disabled={!rpPreview || loading}
              onClick={() =>
                run(async () => {
                  setRpResult(
                    await importReceptionPropertyCsv({
                      receptionFileName: rpFile!.fileName,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      dlFilter: rpDl,
                      shinkiFilter: rpShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              取込実行
            </button>
          </div>
          {rpPreview && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              対象 {rpPreview.summary.filteredCount}件 / 新規作成{" "}
              {rpPreview.summary.toCreateCount}件 / 既存重複{" "}
              {rpPreview.summary.duplicateCount}件 / 住所なし{" "}
              {rpPreview.summary.noAddressCount}件
            </p>
          )}
          {rpResult && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              取込完了: 作成 {rpResult.successCount}件 / 要確認{" "}
              {rpResult.needsReviewCount}件 / エラー {rpResult.errorCount}件(
              <Link
                href={`/import/jobs/${rpResult.jobId}`}
                className="underline"
              >
                詳細
              </Link>
              )
            </p>
          )}
          <div className="text-right">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              次へ(所有者Excel) →
            </button>
          </div>
        </section>
      )}

      {/* ---------- Step 2 ---------- */}
      {step === 2 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ② 所有者Excelで所有者を登録・物件に紐付け
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            受付帳Excel(①と同じファイル)と所有者Excelの2つを指定します。
          </p>
          <div className="space-y-3">
            <div className="space-y-1">
              <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">
                受付帳Excel(①と同じ)
              </span>
              <FilePickerButton
                accept=".xlsx,.csv"
                label="受付帳を選択"
                fileName={rpFile?.fileName ?? null}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  await run(async () => {
                    setRpFile(await readFileForImport(f));
                    setRoPreview(null);
                    setRoResult(null);
                    // 旧ファイルの step1 プレビュー/結果が残ったまま戻って
                    // 古い状態で取込実行できてしまわないよう、こちらもリセットする。
                    setRpPreview(null);
                    setRpResult(null);
                  });
                }}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">
                所有者Excel
              </span>
              <FilePickerButton
                accept=".xlsx,.csv"
                label="所有者を選択"
                fileName={ownerFile?.fileName ?? null}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  await run(async () => {
                    setOwnerFile(await readFileForImport(f));
                    setRoPreview(null);
                    setRoResult(null);
                  });
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              DL列:
              <select
                value={roDl}
                onChange={(e) => {
                  setRoDl(e.target.value as ReceptionDlFilter);
                  setRoPreview(null);
                  setRoResult(null);
                }}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="marked">〇のみ</option>
                <option value="unmarked">〇なしのみ</option>
                <option value="all">すべて</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              新既:
              <select
                value={roShinki}
                onChange={(e) => {
                  setRoShinki(e.target.value as ReceptionShinkiFilter);
                  setRoPreview(null);
                  setRoResult(null);
                }}
                className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="existing">既存のみ</option>
                <option value="new">新規のみ</option>
                <option value="all">すべて</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!rpFile || !ownerFile || loading}
              onClick={() =>
                run(async () => {
                  setRoPreview(
                    await previewReceptionOwnerCsv({
                      receptionFileName: rpFile!.fileName,
                      ownerFileName: ownerFile!.fileName,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      ownerCsv: ownerFile!.csvText,
                      ownerXlsxBase64: ownerFile!.xlsxBase64,
                      dlFilter: roDl,
                      shinkiFilter: roShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              プレビュー
            </button>
            <button
              type="button"
              disabled={!roPreview || loading}
              onClick={() =>
                run(async () => {
                  setRoResult(
                    await importReceptionOwnerCsv({
                      receptionFileName: rpFile!.fileName,
                      ownerFileName: ownerFile!.fileName,
                      receptionCsv: rpFile!.csvText,
                      receptionXlsxBase64: rpFile!.xlsxBase64,
                      ownerCsv: ownerFile!.csvText,
                      ownerXlsxBase64: ownerFile!.xlsxBase64,
                      dlFilter: roDl,
                      shinkiFilter: roShinki,
                    }),
                  );
                })
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              取込実行
            </button>
          </div>
          {roPreview && (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              物件一致 {roPreview.summary.propertyMatchedCount}件 / 物件未発見{" "}
              {roPreview.summary.propertyNotFoundCount}件 / 所有者一致{" "}
              {roPreview.summary.ownerMatchedCount}件
            </p>
          )}
          {roResult && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              取込完了: 成功 {roResult.successCount}件 / 所有者作成{" "}
              {roResult.ownerCreatedCount}件 / 紐付け {roResult.ownerLinkedCount}
              件 / 要確認 {roResult.needsReviewCount}件(
              <Link
                href={`/import/jobs/${roResult.jobId}`}
                className="underline"
              >
                詳細
              </Link>
              )
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              ← 戻る
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              次へ(PDF一括) →
            </button>
          </div>
        </section>
      )}

      {/* ---------- Step 3 ---------- */}
      {step === 3 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ③ 取得済みPDFを一括で物件に添付
          </h2>
          <BulkFolderUpload onUploaded={setBulkSummary} />
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              ← 戻る
            </button>
            <button
              type="button"
              onClick={() => setStep(4)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              次へ(結果) →
            </button>
          </div>
        </section>
      )}

      {/* ---------- Step 4 ---------- */}
      {step === 4 && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-gray-100">
            ④ 結果サマリ
          </h2>
          <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
            <li>
              物件作成:{" "}
              {rpResult
                ? `${rpResult.successCount}件(要確認 ${rpResult.needsReviewCount}件)`
                : "未実行"}
            </li>
            <li>
              所有者登録:{" "}
              {roResult
                ? `作成 ${roResult.ownerCreatedCount}件 / 紐付け ${roResult.ownerLinkedCount}件`
                : "未実行"}
            </li>
            <li>
              PDF添付:{" "}
              {bulkSummary
                ? `${bulkSummary.acceptedTotal}件を受付（${bulkSummary.batchCount}バッチ${
                    bulkSummary.excludedTotal > 0
                      ? ` / 除外 ${bulkSummary.excludedTotal}件`
                      : ""
                  }）`
                : "未実行"}
            </li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/properties"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
            >
              物件一覧へ(売却DMの作成はこちらから)
            </Link>
            <Link
              href="/import"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
            >
              取込履歴を見る
            </Link>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            ※売却DMの対象は、所有者Excelで DM列が〇 だった物件のみです(それ以外は送付対象になりません)。
          </p>
          <div>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300"
            >
              ← 戻る
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
