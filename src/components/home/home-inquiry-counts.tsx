"use client";

import { useEffect, useRef, useState } from "react";
import { fetchAgentInquiryCounts, type InquiryCounts } from "@/lib/api-client";
import { homeInquiryChips } from "@/lib/agent-inquiry/main-view";
import { onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";

const TONE = {
  alert: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  info: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200",
  quiet: "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
} as const;

/** ホームの「未対応の反響」「今日・明日の内見」(見た目)。押すと受付の窓(同じ名前の窓があればそこ)。 */
export function HomeInquiryCountsView({ counts }: { counts: InquiryCounts }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3" aria-label="業者からの反響">
      {homeInquiryChips(counts).map((c) => (
        <a
          key={c.key}
          href="/inquiry-desk"
          target="pm-inquiry-desk"
          className={`flex items-baseline justify-between gap-2 rounded-xl border p-4 shadow-sm transition-colors hover:border-indigo-300 dark:hover:border-indigo-700 ${TONE[c.tone]}`}
        >
          <span className="text-sm font-semibold">{c.label}</span>
          <span className="text-2xl font-bold">
            {c.count}
            <span className="ml-0.5 text-sm font-medium">件</span>
          </span>
        </a>
      ))}
    </div>
  );
}

/** 件数を読んで出す。読めない(権限が無い・通信の失敗)ときは何も出さない=ホームを壊さない。 */
export default function HomeInquiryCounts() {
  const [counts, setCounts] = useState<InquiryCounts | null>(null);
  const genRef = useRef(0);
  useEffect(() => {
    const load = async () => {
      const gen = ++genRef.current;
      try {
        const c = await fetchAgentInquiryCounts();
        if (genRef.current === gen) setCounts(c);
      } catch {
        // 権限を外された後・ログインが切れた後に、古い件数を残さない。
        if (genRef.current === gen) setCounts(null);
      }
    };
    const first = setTimeout(() => void load(), 0);
    const off = onInquiryChanged(() => void load());
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      off();
      window.removeEventListener("focus", onFocus);
      genRef.current += 1;
    };
  }, []);
  if (!counts) return null;
  return <HomeInquiryCountsView counts={counts} />;
}
