/**
 * 物件一覧の小さな表示部品(2026-10-24 従業員の指摘 第2弾)。表(PC)とカード(スマホ)で共有する。
 * - InquirerOrOwnerNames: 「問い合わせ者／所有者」の列(表)。問い合わせ者があればそれ、無ければ所有者。
 *   どちらを出しているかを小さな札(問合せ/所有者)で示す。個人情報なので owner の面で囲む。
 * - LeadExclusionListBadge: 案件ステータスの横の「除外申請中 N日」(7日以上は赤で「運営に確認」)。
 */
import { badgeIntentClass } from "@/components/ui/status-badge";
import { ownerColumnDisplay } from "@/lib/inquirer-name";
import { leadExclusionBadge } from "@/lib/lead-exclusion";

const KIND_LABEL_CLASS: Record<"inquirer" | "owner", string> = {
  inquirer:
    "mr-1 inline-flex shrink-0 rounded px-1 py-px text-[10px] font-medium align-middle bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  owner:
    "mr-1 inline-flex shrink-0 rounded px-1 py-px text-[10px] font-medium align-middle bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

export function InquirerOrOwnerNames({
  inquirerName,
  ownerNames,
}: {
  inquirerName: string | null | undefined;
  ownerNames: readonly string[] | null | undefined;
}) {
  const d = ownerColumnDisplay(inquirerName, ownerNames);
  if (d.kind === "none") {
    return (
      <span data-pii-protected data-pii-surface="owner">
        —
      </span>
    );
  }
  return (
    <span data-pii-protected data-pii-surface="owner">
      <span className={KIND_LABEL_CLASS[d.kind]}>{d.label}</span>
      {d.names.join("、")}
    </span>
  );
}

export function LeadExclusionListBadge({
  status,
  requestedOn,
  today,
}: {
  status: string | null | undefined;
  requestedOn: string | null | undefined;
  /** JST の今日("YYYY-MM-DD")。一覧の描画ごとに1回だけ決めて渡す。 */
  today: string;
}) {
  const badge = leadExclusionBadge(status, requestedOn, today);
  if (!badge) return null;
  return (
    <span
      className={`ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold align-middle ${badgeIntentClass(badge.intent)}`}
    >
      {badge.text}
    </span>
  );
}
