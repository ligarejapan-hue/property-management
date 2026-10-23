import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseYen, yenText } from "@/lib/deals/money-forms";

export const inputCls =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
        {hint && <span className="ml-1 font-normal text-gray-400">（{hint}）</span>}
      </span>
      {children}
    </label>
  );
}

export function SelectBox({
  label, value, onChange, options, allowEmpty, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** 空欄を選べる(「未設定」)。 */
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  // 保存済みの値が選択肢に無い(担当者が無効になった・種別を設定から外した)ときも、
  // 「未設定」と誤って見せず、その値のまま出す(M2)。
  const unknown = value !== "" && !options.some((o) => o.value === value);
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      {allowEmpty && <option value="">未設定</option>}
      {unknown && <option value={value}>(使えない値)</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Record の日本語名 → select の選択肢。 */
export const optionsOf = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

/** 金額の入力欄。右に読み取った金額を3桁区切りで出す(打ち間違いに気づけるように)。 */
export function YenInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const n = parseYen(value);
  return (
    <span className="flex items-center gap-2">
      <input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={inputCls} />
      <span className="shrink-0 text-xs tabular-nums text-gray-500">{value.trim() === "" ? "" : n === null ? "数字で入れてください" : `= ${yenText(n)}円`}</span>
    </span>
  );
}

/**
 * 自動計算だが手で直せる欄(設計 §3)。表示 = 上書き ?? 計算。上書きしたら印を付け、「計算に戻す」で消せる。
 */
export function OverrideField({
  label, computed, override, onChange,
}: { label: string; computed: number | null; override: number | undefined; onChange: (v: number | undefined) => void }) {
  const overridden = override !== undefined;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
        <span className="tabular-nums">計算: {computed === null ? "—" : `${yenText(computed)}円`}</span>
        {overridden && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">手で直した値</span>}
      </div>
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric"
          value={overridden ? String(override) : ""}
          placeholder={computed === null ? "" : yenText(computed)}
          onChange={(e) => {
            const v = parseYen(e.target.value);
            onChange(e.target.value.trim() === "" || v === null ? undefined : v);
          }}
          aria-label={`${label}(手で直す)`}
          className={inputCls}
        />
        {overridden && (
          <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            <RotateCcw className="h-4 w-4" />
            計算に戻す
          </Button>
        )}
      </div>
    </div>
  );
}
