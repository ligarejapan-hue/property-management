"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import BusinessPlanForm from "@/components/deals/business-plan-form";
import { dealsApi, errorText } from "@/lib/deals/client";
import type { DealView } from "@/lib/deals/view";

/** 事業計画書(社内用/銀行向け・買取再販だけ)。入力しながら、PDF と同じ形のプレビューを見る画面。 */
export default function BusinessPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [deal, setDeal] = useState<DealView | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <PageHeader title="事業計画書" back={{ href: `/deals/${deal.id}`, to: deal.name }} description={`${deal.dealNo} ・ ${deal.name}`} />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {deal.businessType !== "resale" ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          事業計画書は買取再販の取引だけで作れます。
          <Link href={`/deals/${deal.id}`} className="ml-1 text-blue-600 underline dark:text-blue-400">取引の画面へ戻る</Link>
        </p>
      ) : (
        // 保存した入力が変わったときだけ作り直す(版の番号だけの変化では打ちかけを消さない)。
        <BusinessPlanForm key={JSON.stringify(deal.businessPlan)} deal={deal} onSaved={reload} />
      )}
    </div>
  );
}
