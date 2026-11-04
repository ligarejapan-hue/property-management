import { Button } from "@/components/ui/button";
import {
  dealScopeOf,
  dealScopeOptions,
  estimatedAssignments,
  filterByScope,
  type ScopeAttachment,
  type ScopeDeal,
} from "@/lib/attachments/deal-scope";

/**
 * 買取再販の添付を仕入/売却/共通で分ける部品(2026-11-04 発注者 案A)。
 * 物件に仕入か売却の分かる取引があるときだけ添付タブが出す。推定は「推定」と出し、人が確定する。
 */

const scopeLabel = (deals: readonly ScopeDeal[], scope: string | null): string | null =>
  scope === null ? null : (dealScopeOptions(deals).find((o) => o.value === scope)?.label ?? "(この物件の取引ではない)");

/** 上の絞り込み(すべて/取引ごと/共通/未区分)と、推定どおりに確定するボタン。 */
export function DealScopeBar({
  deals,
  items,
  filter,
  onFilter,
  onConfirmEstimates,
  saving,
}: {
  deals: readonly ScopeDeal[];
  items: readonly ScopeAttachment[];
  filter: string;
  onFilter: (filter: string) => void;
  onConfirmEstimates: () => void;
  saving: boolean;
}) {
  const chips = [
    { value: "all", label: "すべて" },
    ...dealScopeOptions(deals),
    { value: "unset", label: "未区分" },
  ];
  const estimates = estimatedAssignments(items, deals).length;
  return (
    <div data-testid="deal-scope-bar" className="mb-3 space-y-2 rounded-md border border-gray-200 p-2 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="取引で絞り込む">
        <span className="mr-1 text-xs text-gray-500 dark:text-gray-400">取引:</span>
        {chips.map((c) => (
          <Button
            key={c.value}
            type="button"
            size="sm"
            variant={filter === c.value ? "primary" : "secondary"}
            aria-pressed={filter === c.value}
            onClick={() => onFilter(c.value)}
            className="h-7 px-2 text-xs"
          >
            {c.label}
            <span className="ml-1 tabular-nums opacity-80">{filterByScope(items, deals, c.value).length}</span>
          </Button>
        ))}
      </div>
      {estimates > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-amber-800 dark:text-amber-200">
          <span>
            取引が決まっていない添付が{estimates}件あります。仕入の決済日を境に推定した取引を「推定」と出しています。
          </span>
          <Button type="button" size="sm" variant="secondary" disabled={saving} loading={saving} loadingLabel="確定中" onClick={onConfirmEstimates} className="h-7 px-2 text-xs">
            推定どおりに確定
          </Button>
        </div>
      )}
    </div>
  );
}

/** 1件ずつの取引の欄。未区分は推定を添えて出す。 */
export function DealScopeSelect({
  att,
  deals,
  onChange,
  saving,
}: {
  att: ScopeAttachment;
  deals: readonly ScopeDeal[];
  onChange: (scope: string | null) => void;
  saving: boolean;
}) {
  const r = dealScopeOf(att, deals);
  const confirmed = r.estimated ? "" : (r.scope ?? "");
  const options = dealScopeOptions(deals);
  // 決めた取引が今の選択肢に無い(中止にした取引など)ときも、消さずに出す。
  const missing = confirmed !== "" && !options.some((o) => o.value === confirmed);
  const estimateText = r.estimated ? scopeLabel(deals, r.scope) : null;
  return (
    <label className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <span>取引:</span>
      <select
        aria-label="どの取引の書類か"
        value={confirmed}
        disabled={saving}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className={`min-w-0 max-w-full rounded border px-1 py-0.5 text-xs ${
          confirmed === ""
            ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            : "border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        }`}
      >
        <option value="">未区分</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
        {missing && <option value={confirmed}>(中止などの取引)</option>}
      </select>
      {estimateText && (
        <>
          <span className="text-amber-700 dark:text-amber-300">推定: {estimateText}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => onChange(r.scope)}
            className="h-6 px-2 text-xs text-indigo-600 dark:text-indigo-400"
          >
            この取引で確定
          </Button>
        </>
      )}
    </label>
  );
}

/** 入れるときの取引(物件の画面から入れるとき・空=あとで決める)。 */
export function UploadScopeSelect({
  deals,
  value,
  onChange,
}: {
  deals: readonly ScopeDeal[];
  value: string;
  onChange: (scope: string) => void;
}) {
  return (
    <label className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
      <span>入れる書類の取引:</span>
      <select
        aria-label="入れる書類の取引"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
      >
        <option value="">あとで決める</option>
        {dealScopeOptions(deals).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="text-gray-400 dark:text-gray-500">謄本は共通として扱います</span>
    </label>
  );
}

/** 取引の画面から入れるとき(選ばせずに、その取引の書類にする)。 */
export function FixedUploadScopeNote({ deals, dealId }: { deals: readonly ScopeDeal[]; dealId: string }) {
  const label = dealScopeOptions(deals).find((o) => o.value === dealId)?.label ?? "この取引";
  return (
    <p className="mb-2 text-xs text-gray-600 dark:text-gray-300">
      ここで入れた書類は「{label}」の書類になります。<span className="text-gray-400 dark:text-gray-500">謄本は共通として扱います</span>
    </p>
  );
}
