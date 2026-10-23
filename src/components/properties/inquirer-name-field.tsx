/**
 * 物件詳細の「問い合わせ者」(反響で申し込んできた人の氏名・2026-10-24)。
 * - 値が undefined(=API が返さなかった=owner:read が無い)なら行ごと出さない。
 * - 個人情報なので所有者名と同じく data-pii-protected / data-pii-surface="owner" で囲む。
 * - 編集は「物件を編集」の小窓(問い合わせ者を書ける人にだけ欄が出る)。
 */
export default function InquirerNameField({ value }: { value: string | null | undefined }) {
  if (value === undefined) return null;
  const hasValue = value != null && value.trim() !== "";
  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        問い合わせ者
      </dt>
      <dd
        data-pii-protected
        data-pii-surface="owner"
        className={`text-sm ${hasValue ? "text-gray-900 dark:text-gray-100" : "text-gray-400 dark:text-gray-500"}`}
      >
        {hasValue ? value : "—"}
      </dd>
    </div>
  );
}
