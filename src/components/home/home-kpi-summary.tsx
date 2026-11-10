"use client";

import { useEffect, useRef, useState } from "react";
import { fetchAgentInquiryCounts, type InquiryCounts } from "@/lib/api-client";
import { homeInquiryChips } from "@/lib/agent-inquiry/main-view";
import { onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";
import { INQUIRY_KINDS, INQUIRY_KIND_LABELS } from "@/lib/agent-inquiry/constants";

/** 自分の期限切れの次回対応の件数(/api/next-actions/mine/overdue-counts)。 */
export interface OverdueCounts {
  total: number;
  within3: number;
  within7: number;
  older: number;
}

const TONE = {
  alert: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  warn: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  info: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200",
  quiet: "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300",
} as const;

interface Tile {
  key: string;
  label: string;
  count: number;
  tone: keyof typeof TONE;
  href: string;
  /** 受付の窓は名前付きの窓で開く(同じ名前の窓があればそこ)。 */
  target?: string;
  breakdown: { label: string; count: number }[];
}

/** 見せる数字の組み立て。読めなかった方(null)は出さない。 */
export function homeKpiTiles(inquiry: InquiryCounts | null, overdue: OverdueCounts | null): Tile[] {
  const tiles: Tile[] = [];
  const chips = inquiry ? homeInquiryChips(inquiry) : [];
  const open = chips.find((c) => c.key === "open");
  if (inquiry && open) {
    tiles.push({
      ...open, href: "/inquiry-desk", target: "pm-inquiry-desk",
      breakdown: INQUIRY_KINDS.map((k) => ({ label: INQUIRY_KIND_LABELS[k], count: inquiry.openByKind?.[k] ?? 0 })),
    });
  }
  if (overdue) {
    tiles.push({
      key: "overdue", label: "期限切れの次回対応", count: overdue.total, tone: overdue.total > 0 ? "warn" : "quiet",
      // 同じページの「自分の次回対応」の欄へ。
      href: "#my-next-actions",
      breakdown: [
        { label: "3日以内", count: overdue.within3 },
        { label: "4〜7日", count: overdue.within7 },
        { label: "8日以上", count: overdue.older },
      ],
    });
  }
  const viewings = chips.find((c) => c.key === "viewings");
  if (inquiry && viewings) {
    tiles.push({
      ...viewings, href: "/inquiry-desk", target: "pm-inquiry-desk",
      breakdown: [
        { label: "今日", count: inquiry.viewingsToday ?? 0 },
        { label: "明日", count: inquiry.viewingsTomorrow ?? 0 },
      ],
    });
  }
  return tiles;
}

const COLS: Record<number, string> = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" };

/** ホームの重要指標(見た目)。0件は静かな色。何も読めなければ何も出さない。 */
export function HomeKpiSummaryView({ inquiry, overdue }: { inquiry: InquiryCounts | null; overdue: OverdueCounts | null }) {
  const tiles = homeKpiTiles(inquiry, overdue);
  if (tiles.length === 0) return null;
  return (
    <div className={`mb-3 grid grid-cols-1 gap-3 ${COLS[tiles.length]}`} aria-label="重要な数字">
      {tiles.map((t) => (
        <a
          key={t.key}
          href={t.href}
          target={t.target}
          className={`flex flex-wrap items-baseline justify-between gap-x-2 rounded-xl border p-4 shadow-sm transition-colors hover:border-indigo-300 sm:flex-col sm:flex-nowrap sm:items-stretch dark:hover:border-indigo-700 ${TONE[t.tone]}`}
        >
          <span className="text-sm font-semibold">{t.label}</span>
          <span className="text-2xl font-bold">
            {t.count}
            <span className="ml-0.5 text-sm font-medium">件</span>
          </span>
          <span className="mt-2 flex w-full flex-wrap gap-x-3 gap-y-0.5 border-t border-dashed border-current/30 pt-2 text-xs sm:flex-col">
            {t.breakdown.map((b) => (
              <span key={b.label} className="flex justify-between gap-1">
                <span>{b.label}</span>
                <span className="font-semibold">{b.count}</span>
              </span>
            ))}
          </span>
        </a>
      ))}
    </div>
  );
}

/** 読んで出す。読めない(権限が無い・通信の失敗)方は出さない=ホームを壊さない。 */
export default function HomeKpiSummary() {
  const [inquiry, setInquiry] = useState<InquiryCounts | null>(null);
  const [overdue, setOverdue] = useState<OverdueCounts | null>(null);
  const inqGen = useRef(0);
  const odGen = useRef(0);
  useEffect(() => {
    const loadInquiry = async () => {
      const gen = ++inqGen.current;
      try {
        const c = await fetchAgentInquiryCounts();
        if (inqGen.current === gen) setInquiry(c);
      } catch {
        // 権限を外された後・ログインが切れた後に、古い件数を残さない。
        if (inqGen.current === gen) setInquiry(null);
      }
    };
    const loadOverdue = async () => {
      const gen = ++odGen.current;
      try {
        const res = await fetch("/api/next-actions/mine/overdue-counts", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as OverdueCounts;
        if (odGen.current === gen) setOverdue(body);
      } catch {
        if (odGen.current === gen) setOverdue(null);
      }
    };
    const first = setTimeout(() => {
      void loadInquiry();
      void loadOverdue();
    }, 0);
    const off = onInquiryChanged(() => void loadInquiry());
    const onFocus = () => {
      void loadInquiry();
      void loadOverdue();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      off();
      window.removeEventListener("focus", onFocus);
      inqGen.current += 1;
      odGen.current += 1;
    };
  }, []);
  return <HomeKpiSummaryView inquiry={inquiry} overdue={overdue} />;
}
