"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  FIRST_HOUR, LAST_HOUR, WEEK_KIND_LABEL, addDaysYmd, buildWeekDays, hourRow, hourRowLabel, jstTodayYmd, weekStartOf,
  type WeekItem, type WeekItemKind, type WeekResponse,
} from "@/lib/home/week";

/** 種類ごとの色(文字でも区別する=色だけに頼らない)。 */
const KIND_CLS: Record<WeekItemKind, string> = {
  next_action: "border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
  viewing: "border-teal-500 bg-teal-50 text-teal-800 dark:bg-teal-500/10 dark:text-teal-200",
  contract: "border-violet-500 bg-violet-50 text-violet-800 dark:bg-violet-500/10 dark:text-violet-200",
  settlement: "border-sky-500 bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-200",
};
const OVERDUE_CLS = "border-red-500 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300";
const DOT_CLS: Record<WeekItemKind | "overdue", string> = {
  next_action: "bg-amber-500", viewing: "bg-teal-500", contract: "bg-violet-500", settlement: "bg-sky-500", overdue: "bg-red-500",
};

function itemText(it: WeekItem, withTime: boolean): string {
  const head = it.overdue ? "期限切れ" : WEEK_KIND_LABEL[it.kind];
  return [withTime && it.time ? it.time : null, head, it.sub, it.title, it.who ? `（${it.who}）` : null]
    .filter(Boolean)
    .join(" ");
}

function Chip({ it, withTime }: { it: WeekItem; withTime: boolean }) {
  const cls = `block truncate rounded border-l-[3px] px-1.5 py-0.5 text-xs hover:opacity-80 ${it.overdue ? OVERDUE_CLS : KIND_CLS[it.kind]}`;
  const text = itemText(it, withTime);
  if (it.desk) {
    return (
      <a href={it.href} target="pm-inquiry-desk" className={cls} title={text}>
        {text}
      </a>
    );
  }
  return (
    <Link href={it.href} className={cls} title={text}>
      {text}
    </Link>
  );
}

function formatRange(weekStart: string): string {
  const f = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
  return `${f(weekStart)}〜${f(addDaysYmd(weekStart, 6))}`;
}

const BTN = "px-2.5 py-1 text-xs transition-colors";
const BTN_ON = "bg-indigo-600 text-white dark:bg-indigo-500";
const BTN_OFF = "bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800";

export interface WeekCalendarControls {
  onScope: (s: "mine" | "all") => void;
  onWeek: (delta: -1 | 0 | 1) => void;
}

/** ホームの「今週の予定」(見た目)。PC は時刻のグリッド、スマホは日ごとの縦並び。 */
export function HomeWeekCalendarView({ data, today, controls }: { data: WeekResponse; today: string; controls?: WeekCalendarControls }) {
  const days = buildWeekDays(data.weekStart, data.items, today);
  const hours: number[] = [];
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) hours.push(h);
  const isThisWeek = data.weekStart === weekStartOf(today);
  return (
    <section id="week-calendar" aria-label="今週の予定" className="mb-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <CalendarDays className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
          {isThisWeek ? "今週の予定" : "週の予定"}（{formatRange(data.weekStart)}）
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {data.canSeeAll && (
            <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700" role="group" aria-label="表示の範囲">
              <button type="button" aria-pressed={data.scope === "mine"} className={`${BTN} ${data.scope === "mine" ? BTN_ON : BTN_OFF}`} onClick={() => controls?.onScope("mine")}>
                自分
              </button>
              <button type="button" aria-pressed={data.scope === "all"} className={`${BTN} ${data.scope === "all" ? BTN_ON : BTN_OFF}`} onClick={() => controls?.onScope("all")}>
                全員
              </button>
            </div>
          )}
          <div className="inline-flex gap-1" role="group" aria-label="週の切り替え">
            <Button variant="secondary" size="sm" onClick={() => controls?.onWeek(-1)}>‹ 前週</Button>
            <Button variant="secondary" size="sm" onClick={() => controls?.onWeek(0)}>今週</Button>
            <Button variant="secondary" size="sm" onClick={() => controls?.onWeek(1)}>次週 ›</Button>
          </div>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-gray-600 dark:text-gray-400">
        {(["next_action", "overdue", "viewing", "contract", "settlement"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <i className={`inline-block h-2.5 w-2.5 rounded-sm ${DOT_CLS[k]}`} aria-hidden="true" />
            {k === "overdue" ? "期限切れ" : WEEK_KIND_LABEL[k]}
          </span>
        ))}
      </div>

      {/* PC: 時刻のグリッド */}
      <div className="hidden overflow-x-auto sm:block">
        <div
          className="grid min-w-[560px] overflow-hidden rounded-lg border border-gray-200 text-xs dark:border-gray-700"
          style={{ gridTemplateColumns: `44px repeat(${days.length}, minmax(0, 1fr))` }}
        >
          <div className="border-b border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
          {days.map((d) => (
            <div
              key={d.date}
              className={`border-b border-r border-gray-200 px-1 py-1 text-center font-semibold last:border-r-0 dark:border-gray-700 ${
                d.isToday ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
              }`}
            >
              {d.label}
              {d.isToday ? " 今日" : ""}
            </div>
          ))}
          <div className="border-b border-r border-gray-200 bg-gray-50 px-1 py-1 text-right text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">終日</div>
          {days.map((d) => (
            <div key={d.date} className="min-h-7 space-y-0.5 border-b border-r border-gray-200 p-0.5 dark:border-gray-700">
              {d.allDay.map((it) => <Chip key={it.key} it={it} withTime={false} />)}
            </div>
          ))}
          {hours.map((h) => (
            <div key={h} className="contents">
              <div className="border-b border-r border-gray-200 bg-gray-50 px-1 py-1 text-right text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                {hourRowLabel(h)}
              </div>
              {days.map((d) => (
                <div key={d.date} className="min-h-7 space-y-0.5 border-b border-r border-gray-200 p-0.5 dark:border-gray-700">
                  {d.timed.filter((it) => hourRow(it.time!) === h).map((it) => <Chip key={it.key} it={it} withTime />)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* スマホ: 日ごとの縦並び(予定の無い日は出さない) */}
      <div className="space-y-2 sm:hidden">
        {days.filter((d) => d.allDay.length + d.timed.length > 0).map((d) => (
          <div key={d.date} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <div className={`px-2 py-1 text-xs font-semibold ${d.isToday ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-300"}`}>
              {d.label}
              {d.isToday ? " 今日" : ""}
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {[...d.allDay, ...d.timed].map((it) => (
                <li key={it.key} className="flex items-center gap-2 px-2 py-1">
                  <span className="w-10 shrink-0 text-xs text-gray-500 dark:text-gray-400">{it.time ?? "終日"}</span>
                  <span className="min-w-0 flex-1"><Chip it={it} withTime={false} /></span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {data.items.length === 0 && <p className="text-xs text-gray-500 dark:text-gray-400">この週の予定はありません。</p>}
      </div>
      {data.items.length === 0 && <p className="mt-2 hidden text-xs text-gray-500 sm:block dark:text-gray-400">この週の予定はありません。</p>}
      {data.hasMore && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">予定が多いため、種類ごとに200件までを表示しています。</p>}
    </section>
  );
}

/** 読んで出す。読めない(権限が無い・通信の失敗)ときは何も出さない=ホームを壊さない。 */
export default function HomeWeekCalendar() {
  const [data, setData] = useState<WeekResponse | null>(null);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [week, setWeek] = useState<string | null>(null);
  const genRef = useRef(0);
  useEffect(() => {
    const load = async () => {
      const gen = ++genRef.current;
      try {
        const q = new URLSearchParams({ scope });
        if (week) q.set("week", week);
        const res = await fetch(`/api/home/week?${q.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as WeekResponse;
        if (genRef.current === gen) setData(body);
      } catch {
        // 権限を外された後・ログインが切れた後に、古い予定を残さない。
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
  }, [scope, week]);
  if (!data) return null;
  const controls: WeekCalendarControls = {
    onScope: (s) => setScope(s),
    onWeek: (delta) => setWeek(delta === 0 ? null : addDaysYmd(data.weekStart, delta * 7)),
  };
  return <HomeWeekCalendarView data={data} today={jstTodayYmd(new Date())} controls={controls} />;
}
