"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatJaDateTime } from "@/lib/format-datetime";
import { TIMELINE_CATEGORIES, TIMELINE_FILTER_LABELS, type TimelineEvent, type TimelineFilter, type TimelineSummary } from "@/lib/history-timeline/events";

const FILTERS: TimelineFilter[] = ["all", ...TIMELINE_CATEGORIES];

interface TimelinePage { events: TimelineEvent[]; nextBefore: string | null; summary: TimelineSummary | null }

const dayOf = (iso: string) => formatJaDateTime(iso).slice(0, 10);

/** 上部の「直近の状況」。AI は使わず、データから組み立てる。 */
export function TimelineSummaryCard({ summary }: { summary: TimelineSummary }) {
  const rows: [string, string][] = [
    ...summary.statuses.map((s): [string, string] => [s.label, s.value]),
    ["次の段取り", summary.next ? `${summary.next.due} ${summary.next.label}` : "なし"],
    ["最後のやり取り", summary.lastContactAt ? dayOf(summary.lastContactAt) : "なし"],
    ...(summary.pendingDocs === null ? [] : [["未受領の書類", `${summary.pendingDocs}件`] as [string, string]]),
  ];
  return (
    <section aria-label="直近の状況" className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">直近の状況</h3>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="break-words text-gray-900 dark:text-gray-100">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 1行=日時・誰が・何をしたか。詳細があれば開ける。 */
export function TimelineRow({ event }: { event: TimelineEvent }) {
  const when = event.dateOnly ? dayOf(event.at) : formatJaDateTime(event.at);
  const line = (
    <span className="flex flex-wrap items-baseline gap-x-3">
      <span className="tabular-nums text-xs text-gray-500 dark:text-gray-400">{when}</span>
      {event.actor && <span className="text-xs text-gray-600 dark:text-gray-400">{event.actor}</span>}
      <span className="min-w-0 break-words text-gray-900 dark:text-gray-100">{event.title}</span>
      {event.dealLabel && <span className="text-xs text-gray-500 dark:text-gray-400">{event.dealLabel}</span>}
    </span>
  );
  const open = event.href && (
    <Link href={event.href} className="mt-1 inline-block text-xs text-indigo-700 hover:underline dark:text-indigo-400">元の画面を開く</Link>
  );
  return (
    <li className="px-3 py-2 text-sm">
      {event.detail ? (
        <details>
          <summary className="cursor-pointer">{line}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{event.detail}</p>
          {open}
        </details>
      ) : (
        <>
          {line}
          {open && <div>{open}</div>}
        </>
      )}
    </li>
  );
}

/** 物件・取引の「経緯」タブ。url=/api/properties/:id/timeline か /api/deals/:id/timeline。開いたときに読む。 */
export default function HistoryTimeline({ url }: { url: string }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [summary, setSummary] = useState<TimelineSummary | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (category: TimelineFilter, before: string | null): Promise<TimelinePage> => {
    const params = new URLSearchParams({ category });
    if (before) params.set("before", before);
    const res = await fetch(`${url}?${params}`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as TimelinePage;
  }, [url]);

  useEffect(() => {
    let alive = true;
    fetchPage(filter, null)
      .then((page) => {
        if (!alive) return;
        setEvents(page.events);
        setNextBefore(page.nextBefore);
        if (page.summary) setSummary(page.summary);
        setError(null);
      })
      .catch(() => { if (alive) setError("経緯を読み込めませんでした。"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [fetchPage, filter]);

  const choose = (next: TimelineFilter) => {
    if (next === filter) return;
    setLoading(true);
    setEvents([]);
    setNextBefore(null);
    setFilter(next);
  };

  const more = async () => {
    if (!nextBefore || loading) return;
    setLoading(true);
    try {
      const page = await fetchPage(filter, nextBefore);
      setEvents((xs) => [...xs, ...page.events]);
      setNextBefore(page.nextBefore);
      setError(null);
    } catch {
      setError("経緯を読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4" data-pii-protected data-pii-surface="history">
      {summary && <TimelineSummaryCard summary={summary} />}
      <div className="flex flex-wrap gap-2" role="group" aria-label="種類で絞り込む">
        {FILTERS.map((f) => (
          <Button key={f} size="sm" variant={f === filter ? "primary" : "secondary"} aria-pressed={f === filter} disabled={loading} onClick={() => choose(f)}>
            {TIMELINE_FILTER_LABELS[f]}
          </Button>
        ))}
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {events.length > 0 && (
        <ol className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {events.map((e) => <TimelineRow key={e.id} event={e} />)}
        </ol>
      )}
      {!loading && !error && events.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">表示できる経緯はありません。</p>}
      {loading && <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</p>}
      {nextBefore && !loading && <Button variant="secondary" onClick={() => void more()}>もっと見る</Button>}
    </div>
  );
}
