import type { ReactNode } from "react";

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
  label, value, onChange, options, allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** 空欄を選べる(「未設定」)。 */
  allowEmpty?: boolean;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      {allowEmpty && <option value="">未設定</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Record の日本語名 → select の選択肢。 */
export const optionsOf = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
