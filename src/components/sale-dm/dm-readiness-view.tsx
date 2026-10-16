import Link from "next/link";
import type { DmReadiness } from "@/lib/sale-dm-letter/dm-readiness";

const MARK: Record<"ok" | "warn" | "ng", { sign: string; className: string; label: string }> = {
  ok: { sign: "✓", className: "text-emerald-700 dark:text-emerald-300", label: "そろっています" },
  warn: { sign: "!", className: "text-amber-700 dark:text-amber-300", label: "足りないものがあります" },
  ng: { sign: "×", className: "text-rose-700 dark:text-rose-300", label: "このままでは作れません" },
};

/**
 * DMメニューの「準備チェック」の見た目(テスト用に切り出し・第4回 E)。
 * 直す画面は管理者だけが開ける。管理者でない人には押せないリンクを出さず「管理者にご依頼ください」にする
 * (押せそうに見えて開けないリンクは出さない=@codex #411 R5 P2 と同じ決まり)。
 */
export function DmReadinessView({ readiness, isAdmin }: { readiness: DmReadiness; isAdmin: boolean }) {
  return (
    <div className="space-y-2">
      <p
        data-testid="dm-readiness-summary"
        className={`text-sm font-semibold ${readiness.allOk ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}
      >
        {readiness.allOk ? "売却DMを作る準備はそろっています。" : "売却DMを作る前に、×の項目を直してください。"}
      </p>
      <ul className="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
        {readiness.items.map((item) => {
          const mark = MARK[item.level];
          return (
            <li key={item.key} data-testid="dm-readiness-item" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <span aria-label={mark.label} className={`w-4 shrink-0 text-center font-bold ${mark.className}`}>
                {mark.sign}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-gray-900 dark:text-gray-100">{item.label}</span>
                <span className="block text-xs text-gray-600 dark:text-gray-300">{item.detail}</span>
              </span>
              {item.level !== "ok" &&
                (isAdmin ? (
                  <Link href={item.fixHref} className="shrink-0 text-xs font-semibold text-indigo-700 underline underline-offset-2 dark:text-indigo-300">
                    直す
                  </Link>
                ) : (
                  <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">管理者にご依頼ください</span>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
