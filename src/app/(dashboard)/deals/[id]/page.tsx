"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import DealBasicPanel from "@/components/deals/deal-basic-panel";
import DealPropertyPanel from "@/components/deals/deal-property-panel";
import DealPartiesPanel from "@/components/deals/deal-parties-panel";
import DealMoneyPanel from "@/components/deals/deal-money-panel";
import DealSettlementPanel from "@/components/deals/deal-settlement-panel";
import DealOcPanel from "@/components/deals/deal-oc-panel";
import { dealsApi, errorText, type DealOptions, type UserOption } from "@/lib/deals/client";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import { basicFormFromDeal } from "@/lib/deals/forms";
import { MONEY_OVERRIDE_KEYS, SETTLEMENT_OVERRIDE_KEYS, pickOverrides } from "@/lib/deals/money-forms";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS } from "@/lib/deals/constants";

// 段5で「書類」を足す(設計 §5)。
const DEAL_TABS = [
  { key: "basic", label: "基本" },
  { key: "property", label: "物件" },
  { key: "parties", label: "当事者" },
  { key: "money", label: "金額・費用" },
  { key: "settlement", label: "精算" },
  { key: "oc", label: "OC" },
] as const;
type DealTabKey = (typeof DEAL_TABS)[number]["key"];

/**
 * 取引の詳しい画面。パネルは全部描いて、選んでいないタブは hidden で隠す(タブを替えても入力が消えない・M3)。
 * 各パネルの key は「そのパネルが表すデータ」の JSON。ほかのパネルの保存で版が変わっても作り直さない=打ちかけが残る。
 */
export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ deal: DealView; canOpenProperty: boolean } | null>(null);
  const [calc, setCalc] = useState<DealCalc | null>(null);
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selected, setSelected] = useState<DealTabKey>("basic");
  const [error, setError] = useState<string | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);

  /** 取引と計算は別々に読み直す。計算だけ失敗しても取引(版の番号)は新しくする(最終レビュー M-3)。 */
  const loadCalc = useCallback(async () => {
    try {
      setCalc((await dealsApi.calc(id)).calc);
      setCalcError(null);
    } catch (e) {
      // 古い計算(前の金額・お支払額)を今の結果として出さない(@codex 3巡目)。
      setCalc(null);
      setCalcError(`計算を読み込めませんでした: ${errorText(e)}`);
    }
  }, [id]);

  const reload = useCallback(async () => {
    try {
      setData(await dealsApi.get(id));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
    await loadCalc();
  }, [id, loadCalc]);

  useEffect(() => {
    dealsApi.get(id).then(setData).catch((e) => setError(errorText(e)));
    dealsApi.calc(id).then((c) => setCalc(c.calc)).catch((e) => setCalcError(`計算を読み込めませんでした: ${errorText(e)}`));
    dealsApi.options().then(setOptions).catch(() => {});
    dealsApi.users().then((r) => setUsers(r.data)).catch(() => {});
  }, [id]);

  if (!data) {
    return error ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }
  const { deal } = data;
  const tabs = DEAL_TABS.filter((t) => deal.hasOc || t.key !== "oc");
  // OC を外したあとに OC タブを選んでいたら、基本タブを出す。
  const tab: DealTabKey = tabs.some((t) => t.key === selected) ? selected : "basic";
  const k = (v: unknown) => JSON.stringify(v);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={deal.name}
        back={{ href: "/deals", to: "取引" }}
        description={`${deal.dealNo} ・ ${DEAL_BUSINESS_TYPE_LABELS[deal.businessType as keyof typeof DEAL_BUSINESS_TYPE_LABELS] ?? deal.businessType} ・ ${DEAL_STATUS_LABELS[deal.status as keyof typeof DEAL_STATUS_LABELS] ?? deal.status}`}
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {calcError && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{calcError}</p>}
      <Tabs tabs={tabs} active={tab} onChange={setSelected} idBase="deal-detail" />
      <div {...tabPanelProps("deal-detail", tab)}>
        <div hidden={tab !== "basic"}>
          <DealBasicPanel key={k(basicFormFromDeal(deal))} deal={deal} users={users} kinds={options?.propertyKinds ?? []} onSaved={reload} />
        </div>
        <div hidden={tab !== "property"}>
          <DealPropertyPanel key={k([deal.propertySnapshot, deal.assessments])} deal={deal} canOpenProperty={data.canOpenProperty} onSaved={reload} />
        </div>
        <div hidden={tab !== "parties"}>
          <DealPartiesPanel deal={deal} selfParty={options?.selfParty ?? null} onSaved={reload} />
        </div>
        <div hidden={tab !== "money"}>
          <DealMoneyPanel key={k([deal.price, deal.deposit, deal.taxRateBp, deal.costs, pickOverrides(deal.overrides, MONEY_OVERRIDE_KEYS)])} deal={deal} calc={calc} onSaved={reload} />
        </div>
        <div hidden={tab !== "settlement"}>
          <DealSettlementPanel key={k([{ ...deal.settlementTerms, depositMode: null }, pickOverrides(deal.overrides, SETTLEMENT_OVERRIDE_KEYS)])} deal={deal} calc={calc} onSaved={reload} />
        </div>
        {deal.hasOc && (
          <div hidden={tab !== "oc"}>
            <DealOcPanel key={k([deal.leases, deal.settlementTerms.depositMode])} deal={deal} calc={calc} onSaved={reload} />
          </div>
        )}
      </div>
    </div>
  );
}
