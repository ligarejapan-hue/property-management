import { caseDateLabels, caseDateNotice, formatDateOnlyJa, showsCaseDates, todayDateOnly, type CaseDateField } from "@/lib/case-dates";

/**
 * 物件詳細の「契約予定日」「決済予定日」(2026-10-23 発注者指示)。
 * 案件ステータスが 契約予定/契約完了/決済完了 のときだけ、案件ステータスのすぐ下に出る。
 * ⚠見せるだけ(2026-11-26 発注者「入れるのは取引からのみ」)。値は連動する取引の契約日時・決済日時の写し
 *   (lib/deals/case-dates-sync.ts)。取引の無い物件は、前に入れた日付をそのまま見せる。
 */
export default function CaseDatesField({
  property,
  today = todayDateOnly(),
}: {
  property: { caseStatus: string; contractPlannedOn: string | null; settlementPlannedOn: string | null; deals?: unknown[] | null };
  /** 「あと N 日」の基準(テスト用に差し替え可)。 */
  today?: string;
}) {
  if (!showsCaseDates(property.caseStatus)) return null;

  const labels = caseDateLabels(property.caseStatus);
  const notice = caseDateNotice(property.caseStatus, property.contractPlannedOn, property.settlementPlannedOn, today);
  const hasDeal = (property.deals?.length ?? 0) > 0;

  const noticeEl = notice && (
    <span
      className={
        notice.kind === "overdue"
          ? "inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          : "inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
      }
    >
      {notice.text}
    </span>
  );

  const fields: { field: CaseDateField; label: string; value: string | null }[] = [
    { field: "contractPlannedOn", label: labels.contract, value: property.contractPlannedOn },
    { field: "settlementPlannedOn", label: labels.settlement, value: property.settlementPlannedOn },
  ];

  return (
    <div className="md:col-span-2 grid grid-cols-1 gap-3 rounded-r-md border-l-2 border-indigo-400 bg-indigo-50/60 px-3 py-2 sm:grid-cols-2 dark:border-indigo-500 dark:bg-indigo-950/30">
      {fields.map(({ field, label, value }) => (
        <div key={field}>
          <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</dt>
          <dd className="flex flex-wrap items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
            <span>{formatDateOnlyJa(value)}</span>
            {/* 知らせは「今見ている予定日」の欄に添える(契約予定→契約・契約完了→決済)。 */}
            {((property.caseStatus === "contract_planned" && field === "contractPlannedOn") ||
              (property.caseStatus === "contracted" && field === "settlementPlannedOn")) &&
              noticeEl}
          </dd>
        </div>
      ))}
      <p className="sm:col-span-2 text-xs text-gray-500 dark:text-gray-400">
        {hasDeal
          ? "取引の契約日時・決済日時が入ります。変えるときは取引の基本タブで入れてください。"
          : "取引を作ると、取引の契約日時・決済日時が入ります。"}
      </p>
    </div>
  );
}
