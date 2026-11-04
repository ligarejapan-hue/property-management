"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3, Calculator, Loader2, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import DealBasicPanel from "@/components/deals/deal-basic-panel";
import DealPropertyPanel from "@/components/deals/deal-property-panel";
import DealPartiesPanel from "@/components/deals/deal-parties-panel";
import DealMoneyPanel from "@/components/deals/deal-money-panel";
import DealSettlementPanel from "@/components/deals/deal-settlement-panel";
import DealOcPanel from "@/components/deals/deal-oc-panel";
import DealDocumentsPanel from "@/components/deals/deal-documents-panel";
import DealPropertySide from "@/components/deals/deal-property-side";
import DealAttachmentsPanel from "@/components/deals/deal-attachments-panel";
import HistoryTimeline from "@/components/history-timeline/history-timeline";
import { DealRegistryRights } from "@/components/deals/deal-registry-rights";
import { DealCrosscheck } from "@/components/deals/deal-crosscheck";
import { DealSchedule } from "@/components/deals/deal-schedule";
import { DealDocLinks } from "@/components/deals/deal-doc-links";
import { dealsApi, errorText, type DealOptions, type UserOption } from "@/lib/deals/client";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import { basicFormFromDeal } from "@/lib/deals/forms";
import { MONEY_OVERRIDE_KEYS, SETTLEMENT_OVERRIDE_KEYS, pickOverrides } from "@/lib/deals/money-forms";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { dealTitle } from "@/lib/deals/deal-title";
import { sellerNameMismatch, type CrosscheckResult } from "@/lib/deals/crosscheck";
// 横の物件の編集が鍵のヘッダを送るので、合言葉の一生をこの画面でも持つ。
import { useEditScreenToken } from "@/hooks/use-edit-screen-token";
import { useWideScreen } from "@/hooks/use-wide-screen";

// 「書類」=発行した書類の履歴(設計 §5・段3で追加)。
const DEAL_TABS = [
  { key: "basic", label: "基本" },
  { key: "property", label: "物件" },
  { key: "parties", label: "当事者" },
  { key: "money", label: "金額・費用" },
  { key: "settlement", label: "精算" },
  { key: "oc", label: "OC" },
  { key: "documents", label: "書類" },
  // 物件の添付ファイル(この取引の分から出す・2026-11-04 案A)。物件を開ける人だけ。
  { key: "attachments", label: "添付" },
  { key: "timeline", label: "経緯" },
] as const;
const HEADER_LINK_CLS =
  "inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800";
type DealTabKey = (typeof DEAL_TABS)[number]["key"];

/**
 * 取引の詳しい画面。パネルは全部描いて、選んでいないタブは hidden で隠す(タブを替えても入力が消えない・M3)。
 * 各パネルの key は「そのパネルが表すデータ」の JSON。ほかのパネルの保存で版が変わっても作り直さない=打ちかけが残る。
 */
export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  useEditScreenToken();
  const [data, setData] = useState<{ deal: DealView; canOpenProperty: boolean; canChangeStatus: boolean; canChangeAssignee: boolean; canMoveCaseStatus: boolean } | null>(null);
  const [caseStatusNotChanged, setCaseStatusNotChanged] = useState(false);
  const [calc, setCalc] = useState<DealCalc | null>(null);
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selected, setSelected] = useState<DealTabKey>("basic");
  const [sideRequested, setSideRequested] = useState(false);
  // 当事者タブでは所有者を自動で横に出す。閉じたら、押して開くまで出さない。
  const [partiesSideClosed, setPartiesSideClosed] = useState(false);
  const [sideEditing, setSideEditing] = useState(false);
  const [crosscheckResult, setCrosscheckResult] = useState<CrosscheckResult | null>(null);
  const wideScreen = useWideScreen();
  const [error, setError] = useState<string | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);
  // 書類を発行したら照合を読み直す。
  const [issuedTick, setIssuedTick] = useState(0);
  const [docLinkTick, setDocLinkTick] = useState(0);

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
  const propertyId = data.canOpenProperty && deal.propertyId ? deal.propertyId : null;
  const tabs = DEAL_TABS.filter((t) => (deal.hasOc || t.key !== "oc") && (propertyId !== null || t.key !== "attachments"));
  // OC を外したあとに OC タブを選んでいたら、基本タブを出す。
  const tab: DealTabKey = tabs.some((t) => t.key === selected) ? selected : "basic";
  const k = (v: unknown) => JSON.stringify(v);
  // 狭い画面の横の欄は全画面に重なるので、当事者タブでも自動では開かない。
  const sideOpen = propertyId !== null && (sideRequested || (wideScreen && tab === "parties" && !partiesSideClosed));
  const closeSide = () => { setSideRequested(false); setSideEditing(false); if (tab === "parties") setPartiesSideClosed(true); };
  const openSide = () => { setSideRequested(true); setPartiesSideClosed(false); };
  const sideView = tab === "parties" ? "owners" : "property";
  // 編集の入力欄は狭いと使いにくいので、編集中だけ左右を半分ずつにする。
  const sideGrid = sideEditing ? "lg:grid-cols-2" : "lg:grid-cols-[minmax(0,1fr)_22rem]";

  return (
    <div className={`mx-auto space-y-5 ${sideOpen ? "max-w-7xl" : "max-w-4xl"}`}>
      <PageHeader
        title={dealTitle(deal)}
        back={{ href: "/deals", to: "取引" }}
        actions={
          <div className="flex flex-wrap gap-2">
            {/* 開く権限がある人にだけ出す。 */}
            {data.canOpenProperty && deal.propertyId && (
              <Button variant="secondary" size="sm" disabled={sideEditing} onClick={sideOpen ? closeSide : openSide} aria-pressed={sideOpen}>
                <PanelRight className="h-4 w-4" />
                {sideView === "owners" ? "所有者情報を見る" : "物件情報を見る"}
              </Button>
            )}
            <Link href={`/deals/${deal.id}/funding-plan`} className={HEADER_LINK_CLS}>
              <Calculator className="h-4 w-4" />
              資金計画表
            </Link>
            {/* 事業計画書は買取再販の取引だけ(依頼書 4.2)。 */}
            {deal.businessType === "resale" && (
              <Link href={`/deals/${deal.id}/business-plan`} className={HEADER_LINK_CLS}>
                <BarChart3 className="h-4 w-4" />
                事業計画書
              </Link>
            )}
          </div>
        }
        description={`${deal.dealNo} ・ ${DEAL_BUSINESS_TYPE_LABELS[deal.businessType as keyof typeof DEAL_BUSINESS_TYPE_LABELS] ?? deal.businessType} ・ ${DEAL_STATUS_LABELS[deal.status as keyof typeof DEAL_STATUS_LABELS] ?? deal.status}`}
      />
      {/* 開閉しても同じ位置に描く=入力中のパネルを作り直さない。 */}
      <div className={sideOpen ? `grid items-start gap-5 ${sideGrid}` : ""}>
      <div className="min-w-0 space-y-5">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {calcError && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{calcError}</p>}
      {/* 数値照合。取引の保存・当事者の変更・書類の発行で読み直す。 */}
      <DealCrosscheck onResult={setCrosscheckResult} dealId={deal.id} propertyId={deal.propertyId} canOpenProperty={data.canOpenProperty} revision={k([deal.version, deal.parties, issuedTick])} onOpenTab={setSelected} />
      {/* 決済までの段取り。取引の保存・書類の発行で読み直す。 */}
      <DealSchedule dealId={deal.id} users={users} defaultAssignee={deal.assigneeId} revision={k([deal.version, issuedTick, docLinkTick])} />
      {/* お客様の書類提出。当事者の変更で読み直す。操作したら段取りも読み直す(完了候補・受領の進み具合)。 */}
      <DealDocLinks dealId={deal.id} revision={k([deal.version, deal.parties])} onChanged={() => setDocLinkTick((t) => t + 1)} />
      {/* 物件の謄本の登記の現況(段5c-2)。物件を差し替えたら読み直す。 */}
      <DealRegistryRights key={deal.propertyId ?? "none"} dealId={deal.id} propertyId={deal.propertyId} />
      <Tabs tabs={tabs} active={tab} onChange={setSelected} idBase="deal-detail" />
      <div {...tabPanelProps("deal-detail", tab)}>
        <div hidden={tab !== "basic"}>
          {caseStatusNotChanged && (
            <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" role="status">
              物件の編集権限がないため、案件ステータスは変更していません
            </p>
          )}
          <DealBasicPanel key={k(basicFormFromDeal(deal))} deal={deal} canChangeStatus={data.canChangeStatus} canChangeAssignee={data.canChangeAssignee} canMoveCaseStatus={data.canMoveCaseStatus} users={users} kinds={options?.propertyKinds ?? []} onSaved={reload} onCaseStatusNotChanged={setCaseStatusNotChanged} />
        </div>
        <div hidden={tab !== "property"}>
          <DealPropertyPanel key={k([deal.propertySnapshot, deal.assessments])} deal={deal} canOpenProperty={data.canOpenProperty} onSaved={reload} />
        </div>
        <div hidden={tab !== "parties"}>
          <DealPartiesPanel deal={deal} selfParty={options?.selfParty ?? null} canOpenProperty={data.canOpenProperty} sellerMismatch={sellerNameMismatch(crosscheckResult)} onSaved={reload} />
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
        <div hidden={tab !== "documents"}>
          <DealDocumentsPanel dealId={deal.id} active={tab === "documents"} resale={deal.businessType === "resale"} onIssued={() => setIssuedTick((t) => t + 1)} />
        </div>
        {propertyId && (
          <div hidden={tab !== "attachments"}>
            {/* 物件を差し替えたら作り直す。 */}
            <DealAttachmentsPanel key={propertyId} dealId={deal.id} propertyId={propertyId} active={tab === "attachments"} />
          </div>
        )}
        {tab === "timeline" &&<HistoryTimeline url={`/api/deals/${deal.id}/timeline`} />}
      </div>
      </div>
      {sideOpen && propertyId && (
        <DealPropertySide
          key={propertyId}
          revision={deal.status}
          propertyId={propertyId}
          view={sideView}
          canEdit={data.canMoveCaseStatus}
          onEditingChange={setSideEditing}
          onClose={closeSide}
        />
      )}
      </div>
    </div>
  );
}
