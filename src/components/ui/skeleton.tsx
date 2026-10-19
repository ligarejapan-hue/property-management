/**
 * 読み込み中の形 (UIの統一と押した手応え 第2回・2026-10-19)。
 *
 * くるくるだけの画面を減らし、何が出るかを先に見せる。帯は読み上げない(aria-hidden)。
 * 読み上げは SkeletonRows の role=status + sr-only の文言で1回だけ。
 */
const BAND =
  "rounded bg-[linear-gradient(90deg,var(--color-gray-200)_0%,var(--color-gray-100)_50%,var(--color-gray-200)_100%)] bg-[length:200%_100%] animate-pm-shimmer motion-reduce:animate-none dark:bg-[linear-gradient(90deg,var(--color-gray-800)_0%,var(--color-gray-700)_50%,var(--color-gray-800)_100%)]";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`${BAND}${className ? ` ${className}` : ""}`} />;
}

// 行ごとに長さを少し変える(全部同じ長さだと「形」に見えない)。
const WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-2/3"];

export function SkeletonRows({ rows = 6, label = "読み込み中" }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="flex flex-col gap-3 py-6">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${WIDTHS[i % WIDTHS.length]}`} />
      ))}
    </div>
  );
}
