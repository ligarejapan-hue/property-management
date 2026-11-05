import Link from "next/link";
import { Plus } from "lucide-react";
import { DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { dealSideOf, type DealSide } from "@/lib/property-business-type";
import type { RelatedDeal } from "@/lib/deals/client";

const SIDE_LABELS: Record<DealSide, string> = { purchase: "仕入", sale: "売却" };
const LINK_CLS = "font-medium text-blue-700 underline hover:no-underline dark:text-blue-300";

/** 仕入の取引から売却の取引を作る画面への道(物件を引き継ぐ)。 */
export const newSaleDealHref = (propertyId: string) =>
  `/deals/new?${new URLSearchParams({ propertyId, businessType: "resale", side: "sale" }).toString()}`;

/**
 * 買取再販の取引の「仕入/売却」と、同じ物件のもう一方の取引(2026-11-05 発注者: 仕入と売却は取引を分ける)。
 * 1行だけ出す。仲介の取引には何も出さない。
 * - 仕入で、同じ物件に売却の取引が無ければ「売却の取引を作る」(物件を開ける人だけ)。
 * - 自社が当事者にいない(前に作った取引)ときは、当事者タブで決める案内。
 */
export function DealResaleSide({
  deal, relatedDeals, canOpenProperty,
}: {
  deal: { businessType: string; propertyId: string | null; parties: Array<{ role: string; isSelf: boolean }> };
  relatedDeals: RelatedDeal[];
  canOpenProperty: boolean;
}) {
  if (deal.businessType !== "resale") return null;
  const side = dealSideOf(deal.businessType, deal.parties);
  const others = relatedDeals.filter((d) => d.side !== null && d.status !== "cancelled");
  if (!side) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
        仕入か売却か決まっていません。当事者タブで自社を、仕入なら買主・売却なら売主に入れてください(仕入と売却は別の取引にします)。
      </p>
    );
  }
  const canCreateSale = side === "purchase" && !others.some((d) => d.side === "sale") && canOpenProperty && !!deal.propertyId;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200">
        {SIDE_LABELS[side]}の取引
      </span>
      {others.map((d) => (
        <span key={d.id}>
          同じ物件の{SIDE_LABELS[d.side as DealSide]}の取引:{" "}
          <Link href={`/deals/${d.id}`} className={LINK_CLS}>{d.dealNo}</Link>
          <span className="text-xs text-gray-500">({DEAL_STATUS_LABELS[d.status as keyof typeof DEAL_STATUS_LABELS] ?? d.status})</span>
        </span>
      ))}
      {canCreateSale && deal.propertyId && (
        <Link href={newSaleDealHref(deal.propertyId)} className={`inline-flex items-center gap-1 text-xs ${LINK_CLS}`}>
          <Plus className="h-3.5 w-3.5" />
          売却の取引を作る
        </Link>
      )}
    </p>
  );
}
