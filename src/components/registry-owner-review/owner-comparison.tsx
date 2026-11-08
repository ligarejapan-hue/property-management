/**
 * 謄本の名義の確認: システムの所有者と謄本の名義を左右に並べる(見た目だけ・2026-11-08)。
 * 「謄本の名義に直す」で外れる人・加わる人に印を付ける。
 */
import type { RegistryOwnerReviewDetail } from "@/lib/api-client";

export interface OwnerComparisonProps {
  systemOwners: RegistryOwnerReviewDetail["systemOwners"];
  registryOwners: RegistryOwnerReviewDetail["registryOwners"];
  registryLabel: string;
}

const badge = "ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium";

export default function OwnerComparison({ systemOwners, registryOwners, registryLabel }: OwnerComparisonProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-label="システムの所有者">
        <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">システムの所有者</h3>
        <ul className="space-y-1.5">
          {systemOwners.map((o) => (
            <li key={o.ownerId} className="rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
              <span className="text-gray-900 dark:text-gray-100">{o.name}</span>
              {o.isPrimary ? <span className={`${badge} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300`}>主</span> : null}
              {o.willBeRemoved ? (
                <span className={`${badge} bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300`}>謄本にない</span>
              ) : null}
              {o.address ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{o.address}</p> : null}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="謄本の名義">
        <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
          謄本の名義<span className="ml-2 font-normal text-gray-400">{registryLabel}</span>
        </h3>
        {registryOwners.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">謄本から名義を読み取れませんでした。</p>
        ) : (
          <ul className="space-y-1.5">
            {registryOwners.map((o, i) => (
              <li key={`${o.name}-${i}`} className="rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                <span className="text-gray-900 dark:text-gray-100">{o.name}</span>
                {o.share ? <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">持分 {o.share}</span> : null}
                {o.willBeAdded ? (
                  <span className={`${badge} bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300`}>システムにいない</span>
                ) : null}
                {o.address ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{o.address}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
