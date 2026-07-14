import Link from "next/link";
import { visibleHomeCards } from "./home-model";

/** 役割別ホーム(ランチャー)。カードは既存ページへの Link。userRole は親(page)がセッションから渡す。 */
export function HomeContent({ userRole }: { userRole: string }) {
  const cards = visibleHomeCards(userRole);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-bold text-gray-900 dark:text-gray-100">ホーム</h1>
      <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">やりたいことを選んでください。</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href + c.label}
            href={c.href}
            className={`flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-900/20 ${
              c.big ? "sm:col-span-2" : ""
            }`}
          >
            <span className="mt-0.5 text-indigo-600 dark:text-indigo-400">{c.icon}</span>
            <span className="flex flex-col">
              <span className={`font-semibold text-gray-900 dark:text-gray-100 ${c.big ? "text-lg" : "text-sm"}`}>
                {c.label}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{c.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
