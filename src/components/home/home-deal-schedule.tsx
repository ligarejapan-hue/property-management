"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";

export interface MyDealScheduleItem {
  id: string;
  label: string;
  /** YYYY-MM-DD */
  dueDate: string;
  dealId: string;
  dealNo: string;
  dealTitle: string;
  slot: "tomorrow" | "today" | "overdue" | null;
}

function formatDate(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}`;
}

const SLOT_CLS = "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300";
const OVERDUE_CLS = "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300";

/** ホームの「自分の段取り」(今日・明日・期限超過)の見た目。1件ずつ取引の画面へ。0件なら何も出さない。 */
export function HomeDealScheduleView({ items, hasMore }: { items: MyDealScheduleItem[]; hasMore: boolean }) {
  if (items.length === 0) return null;
  return (
    <section id="my-deal-schedule" aria-label="自分の段取り" className="mb-3 rounded-xl border border-amber-200 bg-white p-4 shadow-sm dark:border-amber-900/60 dark:bg-gray-900">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <ListChecks className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        自分の段取り（今日・明日・期限超過）
      </h2>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {items.map((a) => (
          <li key={a.id}>
            <Link href={`/deals/${a.dealId}`} className="flex items-baseline gap-2 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/60">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${a.slot === "overdue" ? OVERDUE_CLS : SLOT_CLS}`}>
                {a.slot === "overdue" ? `期限超過 ${formatDate(a.dueDate)}` : a.slot === "tomorrow" ? "明日" : "今日"}
              </span>
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{a.label}</span>
              <span className="max-w-[40%] shrink-0 truncate text-xs text-gray-500 dark:text-gray-400">{a.dealTitle}</span>
            </Link>
          </li>
        ))}
      </ul>
      {hasMore && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">期限の古い順に50件まで表示しています。</p>}
    </section>
  );
}

/** 読んで出す。読めない(権限が無い・通信の失敗)ときは何も出さない=ホームを壊さない。 */
export default function HomeDealSchedule() {
  const [data, setData] = useState<{ items: MyDealScheduleItem[]; hasMore: boolean } | null>(null);
  const genRef = useRef(0);
  useEffect(() => {
    const load = async () => {
      const gen = ++genRef.current;
      try {
        const res = await fetch("/api/deals/schedule/mine", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { items: MyDealScheduleItem[]; hasMore: boolean };
        if (genRef.current === gen) setData(body);
      } catch {
        // 権限を外された後・ログインが切れた後に、古い一覧を残さない。
        if (genRef.current === gen) setData(null);
      }
    };
    const first = setTimeout(() => void load(), 0);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      window.removeEventListener("focus", onFocus);
      genRef.current += 1;
    };
  }, []);
  if (!data) return null;
  return <HomeDealScheduleView items={data.items} hasMore={data.hasMore} />;
}
