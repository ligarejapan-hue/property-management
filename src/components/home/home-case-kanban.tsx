"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Columns3 } from "lucide-react";
import { kanbanListHref, type KanbanColumn, type KanbanResponse } from "@/lib/home/case-kanban";

function formatMd(iso: string): string {
  // 日本時間の月/日
  const j = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()}`;
}

function Cards({ col, assignedTo }: { col: KanbanColumn; assignedTo: string | null }) {
  const rest = col.count - col.cards.length;
  return (
    <>
      {col.cards.length === 0 && <p className="text-xs text-gray-400 dark:text-gray-500">なし</p>}
      {col.cards.map((c) => (
        <Link
          key={c.id}
          href={`/properties/${c.id}`}
          className="mb-1.5 block rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs hover:border-indigo-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-indigo-700"
        >
          <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{c.address ?? "（所在なし）"}</span>
          <span className="flex justify-between gap-2 text-gray-500 dark:text-gray-400">
            <span className="truncate">{c.assigneeName ?? "担当なし"}</span>
            <span className="shrink-0">{formatMd(c.updatedAt)}</span>
          </span>
        </Link>
      ))}
      {rest > 0 && (
        <Link href={kanbanListHref(col.status, assignedTo)} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">
          ほか{rest}件 →
        </Link>
      )}
    </>
  );
}

const COUNT_CLS = "rounded-full border border-gray-200 bg-white px-2 text-[11px] font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300";

/** ホームの「案件の進み具合」(見た目)。PC は横に列、スマホは列を縦に並べて開閉。見るだけ。 */
export function HomeCaseKanbanView({ data, onMine }: { data: KanbanResponse; onMine?: (mine: boolean) => void }) {
  const assignedTo = data.mine ? data.selfId : null;
  return (
    <section id="case-kanban" aria-label="案件の進み具合" className="mb-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Columns3 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
          案件の進み具合
        </h2>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 dark:border-gray-600"
            checked={data.mine}
            onChange={(e) => onMine?.(e.target.checked)}
          />
          自分の担当だけ
        </label>
      </div>

      {/* PC: 横に列(はみ出す分は横スクロール) */}
      <div className="hidden gap-2 overflow-x-auto pb-1 sm:flex">
        {data.columns.map((col) => (
          <div key={col.status} className="w-40 shrink-0 rounded-lg bg-gray-100 p-2 dark:bg-gray-800">
            <h3 className="mb-1.5 flex items-center justify-between gap-1 text-xs font-semibold text-gray-800 dark:text-gray-200">
              <span className="truncate">{col.label}</span>
              <span className={COUNT_CLS}>{col.count}</span>
            </h3>
            <Cards col={col} assignedTo={assignedTo} />
          </div>
        ))}
      </div>

      {/* スマホ: 列を縦に。件数のある最初の列だけ開いておく */}
      <div className="space-y-1.5 sm:hidden">
        {data.columns.map((col) => (
          <details
            key={col.status}
            open={col.status === data.columns.find((c) => c.count > 0)?.status}
            className="rounded-lg bg-gray-100 p-2 dark:bg-gray-800"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold text-gray-800 dark:text-gray-200">
              <span>{col.label}</span>
              <span className={COUNT_CLS}>{col.count}</span>
            </summary>
            <div className="mt-1.5">
              <Cards col={col} assignedTo={assignedTo} />
            </div>
          </details>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">各段階の新しく更新された3件まで。ステータスの変更は物件の画面から。</p>
    </section>
  );
}

/** 読んで出す。読めない(権限が無い・通信の失敗)ときは何も出さない=ホームを壊さない。 */
export default function HomeCaseKanban() {
  const [data, setData] = useState<KanbanResponse | null>(null);
  const [mine, setMine] = useState(false);
  const genRef = useRef(0);
  useEffect(() => {
    const load = async () => {
      const gen = ++genRef.current;
      try {
        const res = await fetch(`/api/home/case-kanban${mine ? "?mine=1" : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as KanbanResponse;
        if (genRef.current === gen) setData(body);
      } catch {
        // 権限を外された後・ログインが切れた後に、古い件数を残さない。
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
  }, [mine]);
  if (!data) return null;
  return <HomeCaseKanbanView data={data} onMine={setMine} />;
}
