"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import ImportSwitcher from "@/components/import/import-switcher";
import BulkFolderUpload, {
  type BulkUploadSummary,
} from "@/components/import/bulk-folder-upload";

// ============================================================
// 取得済みPDFを一括添付(旧「登記DM取込」)
// ------------------------------------------------------------
// 外部ツール(不動産登記情報自動化システム)で取得済みの所有者事項PDFを、フォルダごと物件に添付する
// (非同期ジョブ・閉じてもOK)。
// 画面すっきり化 第4回 D(発注者決定 2026-10-16): 以前ここにあった①受付帳Excel→物件作成・
// ②受付帳×所有者Excel は「受付帳CSV取込」(/import)と同じ処理を言葉だけ変えて持っていたため、
// そちらへ1つにまとめた(受付帳は1回だけ入れる)。この画面はPDFの一括添付だけを残す。
// URL(/import/registry-dm)は既存リンク・ブックマークのため据え置く。
// ============================================================

export default function RegistryDmImportPage() {
  const [bulkSummary, setBulkSummary] = useState<BulkUploadSummary | null>(null);

  return (
    <div data-pii-protected data-pii-surface="import" className="space-y-6">
      <ImportSwitcher />
      <PageHeader title="取得済みPDFを一括添付" />
      <p className="text-sm text-gray-600 dark:text-gray-400">
        登記情報自動化ツールで取得済みの所有者事項PDFを、フォルダごと物件に添付します。
        受付帳・所有者のExcelは
        <Link href="/import" className="font-semibold underline underline-offset-2">受付帳CSV取込</Link>
        で取り込んでください(受付帳は1回入れるだけで、物件の作成と所有者の紐づけの両方に使います)。
      </p>

      <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="font-medium text-gray-900 dark:text-gray-100">
          取得済みPDFを一括で物件に添付
        </h2>
        <BulkFolderUpload onUploaded={setBulkSummary} />
        {bulkSummary && (
          <p data-testid="registry-dm-bulk-summary" className="text-sm text-gray-700 dark:text-gray-300">
            {`${bulkSummary.acceptedTotal}件を受付（${bulkSummary.batchCount}バッチ${
              bulkSummary.excludedTotal > 0 ? ` / 除外 ${bulkSummary.excludedTotal}件` : ""
            }）`}
          </p>
        )}
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
      </section>
    </div>
  );
}
