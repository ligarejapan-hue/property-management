"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import FundingPlanForm from "@/components/deals/funding-plan-form";
import { dealsApi, errorText, type DealOptions } from "@/lib/deals/client";
import { DEFAULT_PROPERTY_KINDS } from "@/lib/deals/constants";
import type { DealView } from "@/lib/deals/view";

/** 資金計画表(購入/売却)。入力しながら、PDF と同じ形のプレビューを見る画面。 */
export default function FundingPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [deal, setDeal] = useState<DealView | null>(null);
  const [options, setOptions] = useState<DealOptions | null>(null);
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
      <FundingPlanForm key={JSON.stringify(deal.fundingPlan)} deal={deal} kindBase={kindBase} onSaved={reload} />
    </div>
  );
}
