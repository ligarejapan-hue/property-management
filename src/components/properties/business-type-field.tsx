import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { businessTypeLabel, businessTypeMismatch, type PropertyDealSummary } from "@/lib/property-business-type";

/**
 * 基本情報の「取扱区分」(仲介/買取再販/未定・2026-11-04 発注者)。
 * 取引を見られる人には、この物件の取引(番号・区分・仕入/売却・状態)を横に並べ、
 * 物件の区分と違う取引があれば知らせる。deals=null は取引を見る権限が無い人(取引の行を出さない)。
 */
export default function BusinessTypeField({
  businessType,
  deals,
}: {
  businessType: string | null | undefined;
  deals: PropertyDealSummary[] | null | undefined;
}) {
  const mismatch = deals ? businessTypeMismatch(businessType, deals) : false;
  return (
    <div data-testid="business-type-field">
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">取扱区分</dt>
      <dd className="space-y-1 text-sm text-gray-900 dark:text-gray-100">
        <p>{businessType ? businessTypeLabel(businessType) : <span className="text-gray-500 dark:text-gray-400">未定</span>}</p>
        {deals && deals.length > 0 && (
          <ul className="space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
            {deals.map((d) => (
              <li key={d.id}>
                取引{" "}
                <Link href={`/deals/${d.id}`} className="font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
                  {d.dealNo}
                </Link>
                ：{d.label}・{(DEAL_STATUS_LABELS as Record<string, string>)[d.status] ?? d.status}
              </li>
            ))}
          </ul>
        )}
        {mismatch && (
          <p role="status" className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            物件の取扱区分（{businessTypeLabel(businessType)}）と違う区分の取引があります。物件の編集か取引の事業区分を直してください。
          </p>
        )}
      </dd>
    </div>
  );
}
