"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dealsApi, dealDocumentFileUrl, errorText } from "@/lib/deals/client";
import { CROSSCHECK_STATUS_LABELS, type CrosscheckItem, type CrosscheckResult, type CrosscheckSource, type CrosscheckStatus } from "@/lib/deals/crosscheck";

type TabKey = Extract<NonNullable<CrosscheckSource["link"]>, { kind: "tab" }>["tab"];

const STATUS_CLS: Record<CrosscheckStatus, string> = {
  match: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  mismatch: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
  missing: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  kind_differs: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  notation_differs: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  unverifiable: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
};
const LINK_CLS = "underline hover:no-underline";

/** 出どころのリンク。物件は物件を見られる人だけ(見られない人には文字だけ)。 */
function SourceLabel({ source: s, dealId, propertyId, canOpenProperty, onOpenTab }: {
  source: CrosscheckSource; dealId: string; propertyId: string | null; canOpenProperty: boolean; onOpenTab: (tab: TabKey) => void;
}) {
  const l = s.link;
  if (l?.kind === "tab") return <Button variant="ghost" size="sm" className="underline" onClick={() => onOpenTab(l.tab)}>{s.label}</Button>;
  if (l?.kind === "document") {
    return <a href={dealDocumentFileUrl(dealId, l.documentId, "pdf")} target="_blank" rel="noopener noreferrer" className={LINK_CLS}>{s.label}</a>;
  }
  if (l?.kind === "property" && propertyId && canOpenProperty) {
    return <Link href={`/properties/${propertyId}${l.tab ? `?tab=${l.tab}` : ""}`} className={LINK_CLS}>{s.label}</Link>;
  }
  return <>{s.label}</>;
}

const sourceValue = (s: CrosscheckSource) => s.value ?? (s.state === "empty" ? "未入力" : "確認できない");

function ItemRow({ item, ...rest }: { item: CrosscheckItem; dealId: string; propertyId: string | null; canOpenProperty: boolean; onOpenTab: (tab: TabKey) => void }) {
  return (
    <li className="space-y-1 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLS[item.status]}`}>{CROSSCHECK_STATUS_LABELS[item.status]}</span>
        <span className="font-medium">{item.label}</span>
      </p>
      {item.message && <p className="text-xs text-gray-600 dark:text-gray-400">{item.message}</p>}
      <ul className="space-y-0.5 text-xs text-gray-700 dark:text-gray-300">
        {item.sources.map((s) => (
          <li key={s.key} className="flex flex-wrap justify-between gap-x-4">
            <span><SourceLabel source={s} {...rest} /></span>
            <span className="tabular-nums">{sourceValue(s)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** 結果の表示(取得はしない)。不一致があれば初めから開く。 */
export function CrosscheckPanel({ result: r, dealId, propertyId, canOpenProperty, onOpenTab }: {
  result: CrosscheckResult; dealId: string; propertyId: string | null; canOpenProperty: boolean; onOpenTab: (tab: TabKey) => void;
}) {
  const unchecked = r.items.filter((i) => i.status === "missing" || i.status === "unverifiable").length;
  const head = r.summary === "mismatch"
    ? { cls: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40", icon: <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />, text: `${r.mismatchCount}件の食い違い` }
    : r.summary === "ok"
      ? { cls: "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40", icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />, text: "照合OK" }
      : r.summary === "incomplete"
        ? { cls: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40", icon: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />, text: "確認できていない項目があります" }
        : { cls: "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900", icon: <Info className="h-4 w-4 shrink-0 text-gray-500" />, text: "照合できる項目がありません" };
  return (
    <details open={r.summary === "mismatch" || r.summary === "incomplete" || r.notices.length > 0} className={`rounded-lg border px-3 py-2 text-sm ${head.cls}`}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-semibold">
        {head.icon}
        {head.text}
        {unchecked > 0 && <span className="text-xs font-normal text-gray-600 dark:text-gray-400">(未確認 {unchecked}件)</span>}
      </summary>
      {r.notices.length > 0 && (
        <ul className="mt-2 space-y-1">
          {r.notices.map((n) => (
            <li key={n.id} data-notice-id={n.id} className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{n.message}{n.count ? (n.partial ? `(読めた謄本では ${n.count}件。ほかにも残っているかもしれません)` : `(残っている権利 ${n.count}件)`) : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {r.registries.length > 0 && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
          照合に使った謄本: {r.registries.map((x) => `${x.date.replace(/-/g, "/")} 取込(${x.usedFor.join("・")})`).join(" / ")}
        </p>
      )}
      <ul className="mt-1 divide-y divide-gray-200 dark:divide-gray-800">
        {r.items.map((i) => <ItemRow key={i.key} item={i} dealId={dealId} propertyId={propertyId} canOpenProperty={canOpenProperty} onOpenTab={onOpenTab} />)}
      </ul>
    </details>
  );
}

/** revision が変わったら読み直す(取引の保存・当事者の変更・書類の発行)。 */
export function DealCrosscheck({ dealId, propertyId, canOpenProperty, revision, onOpenTab }: {
  dealId: string; propertyId: string | null; canOpenProperty: boolean; revision: string; onOpenTab: (tab: TabKey) => void;
}) {
  const [result, setResult] = useState<CrosscheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    dealsApi.crosscheck(dealId)
      .then((r) => { if (alive) { setResult(r.crosscheck); setError(null); } })
      // 古い結果を今の結果として出さない。
      .catch((e) => { if (alive) { setResult(null); setError(`照合の結果を読み込めませんでした: ${errorText(e)}`); } });
    return () => { alive = false; };
  }, [dealId, revision]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>;
  if (!result) return null;
  return <CrosscheckPanel result={result} dealId={dealId} propertyId={propertyId} canOpenProperty={canOpenProperty} onOpenTab={onOpenTab} />;
}
