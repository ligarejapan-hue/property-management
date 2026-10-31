"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import BusinessPlanForm from "@/components/deals/business-plan-form";
import type { IssueNotice } from "@/components/deals/funding-plan-form";
import { dealsApi, dealDocumentFileUrl, errorText } from "@/lib/deals/client";
import type { DealView } from "@/lib/deals/view";
import { dealTitle } from "@/lib/deals/deal-title";

/** 事業計画書(社内用/銀行向け・買取再販だけ)。入力しながら、PDF と同じ形のプレビューを見る画面。 */
export default function BusinessPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [deal, setDeal] = useState<DealView | null>(null);
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
  }, [id]);

  if (!deal) {
    return error ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="事業計画書" back={{ href: `/deals/${deal.id}`, to: dealTitle(deal) }} description={`${deal.dealNo} ・ ${dealTitle(deal)}`} />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {/* 発行の結果は画面(親)が持つ=保存のあとに入力欄が作り直されても消えない。 */}
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
      {deal.businessType !== "resale" ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          事業計画書は買取再販の取引だけで作れます。
          <Link href={`/deals/${deal.id}`} className="ml-1 text-blue-600 underline dark:text-blue-400">取引の画面へ戻る</Link>
        </p>
      ) : (
        // 保存した入力が変わったときだけ作り直す(版の番号だけの変化では打ちかけを消さない)。
        <BusinessPlanForm key={JSON.stringify(deal.businessPlan)} deal={deal} onSaved={reload} onIssue={setNotice} />
      )}
    </div>
  );
}
