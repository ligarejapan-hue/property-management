"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";

export interface MyNextAction {
  id: string;
  propertyId: string;
  /** YYYY-MM-DD */
  scheduledAt: string;
  /** "HH:MM"(任意・段階3) */
  scheduledTime?: string | null;
  actionType: string | null;
  overdue: boolean;
  /** 明日の予定(時刻 0:00〜0:04 で、5分前の知らせがもう出たもの)。 */
  tomorrow?: boolean;
  address: string | null;
}

function formatDate(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * ホームの「自分の次回対応」(今日・期限切れ)の見た目。通知 段階2で「次回対応が N 件あります」を
 * 押したときの行き先(設計書 §2 N4)。1件ずつ物件の画面へ。0件なら何も出さない。
 */
export function HomeNextActionsView({ items, hasMore }: { items: MyNextAction[]; hasMore: boolean }) {
  if (items.length === 0) return null;
  return (
    <section id="my-next-actions" aria-label="自分の次回対応" className="mb-3 rounded-xl border border-amber-200 bg-white p-4 shadow-sm dark:border-amber-900/60 dark:bg-gray-900">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <CalendarClock className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        自分の次回対応（今日・期限切れ）
      </h2>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {items.map((a) => (
          <li key={a.id}>
            <Link
              href={`/properties/${a.propertyId}`}
              className="flex items-baseline gap-2 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/60"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${
                  a.overdue
                    ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
                    : "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                }`}
              >
                {a.overdue ? `期限切れ ${formatDate(a.scheduledAt)}` : a.tomorrow ? "明日" : "今日"}
                {a.scheduledTime ? ` ${a.scheduledTime}` : ""}
              </span>
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{a.address ?? "（所在なし）"}</span>
              {a.actionType && <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{a.actionType}</span>}
            </Link>
          </li>
        ))}
      </ul>
      {hasMore && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">今日・明日の予定と、新しい期限切れから50件まで表示しています。</p>}
    </section>
  );
}

/** 読んで出す。読めない(権限が無い・通信の失敗)ときは何も出さない=ホームを壊さない。 */
export default function HomeNextActions() {
  const [data, setData] = useState<{ items: MyNextAction[]; hasMore: boolean } | null>(null);
  const genRef = useRef(0);
  useEffect(() => {
    const load = async () => {
      const gen = ++genRef.current;
      try {
        const res = await fetch("/api/next-actions/mine", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { items: MyNextAction[]; hasMore: boolean };
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
  return <HomeNextActionsView items={data.items} hasMore={data.hasMore} />;
}
