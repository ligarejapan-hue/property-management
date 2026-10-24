"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import FundingPlanForm, { type IssueNotice } from "@/components/deals/funding-plan-form";
import { dealsApi, dealDocumentFileUrl, errorText, type DealOptions } from "@/lib/deals/client";
import { DEFAULT_PROPERTY_KINDS } from "@/lib/deals/constants";
import type { DealView } from "@/lib/deals/view";

/** 資金計画表(購入/売却)。入力しながら、PDF と同じ形のプレビューを見る画面。 */
export default function FundingPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [deal, setDeal] = useState<DealView | null>(null);
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<IssueNotice | null>(null);

  const reload = useCallback(async () => {
    try {
      setDeal((await dealsApi.get(id)).deal);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    dealsApi.get(id).then((r) => setDeal(r.deal)).catch((e) => setError(errorText(e)));
    dealsApi.options().then(setOptions).catch(() => {});
  }, [id]);

  if (!deal) {
    return error ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }
  const kinds = options?.propertyKinds.length ? options.propertyKinds : DEFAULT_PROPERTY_KINDS;
  const kindBase = kinds.find((k) => k.key === deal.propertyKind)?.base ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="資金計画表" back={{ href: `/deals/${deal.id}`, to: deal.name }} description={`${deal.dealNo} ・ ${deal.name}`} />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {/* 保存した入力が変わったときだけ作り直す(版の番号だけの変化では打ちかけを消さない)。 */}
      {notice?.kind === "ok" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200" role="status">
          <span>{notice.title} 第{notice.version}版を発行しました。</span>
          <a href={dealDocumentFileUrl(deal.id, notice.id, "pdf")} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
            <FileText className="h-4 w-4" />
            PDF を開く
          </a>
          <a href={dealDocumentFileUrl(deal.id, notice.id, "xlsx")} className="inline-flex items-center gap-1 underline">
            <FileSpreadsheet className="h-4 w-4" />
            Excel を保存
          </a>
          <Link href={`/deals/${deal.id}`} className="underline">発行の履歴は取引の画面の「書類」タブ</Link>
        </div>
      )}
      {notice?.kind === "error" && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{notice.message}</p>}
      <FundingPlanForm key={JSON.stringify(deal.fundingPlan)} deal={deal} kindBase={kindBase} onSaved={reload} onIssue={setNotice} />
    </div>
  );
}
