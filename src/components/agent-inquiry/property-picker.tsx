"use client";

import { useEffect, useState } from "react";
import { hitsForQuery, type SearchResult } from "@/lib/agent-inquiry/desk-form";
import { searchDeskProperties, type DeskProperty } from "@/lib/api-client";

/** 物件の候補(見た目)。 */
export function PropertyResults({ hits, onPick }: { hits: DeskProperty[]; onPick: (p: DeskProperty) => void }) {
  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-700 dark:bg-gray-900">
      {hits.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onPick(p)}
            className="block w-full px-3 py-2 text-left hover:bg-teal-50 dark:hover:bg-gray-800"
          >
            <span className="block text-sm font-medium">{p.roomNo ? `${p.name} ${p.roomNo}` : p.name}</span>
            <span className="block text-xs text-gray-500">{p.town}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 物件を探す欄(物件名・部屋番号・所在地・設計 §2.2-3)。返るのは許可リストの形だけ。 */
export function PropertyPicker({
  query,
  selected,
  onQuery,
  onPick,
}: {
  query: string;
  selected: DeskProperty | null;
  onQuery: (v: string) => void;
  onPick: (p: DeskProperty) => void;
}) {
  const [res, setRes] = useState<SearchResult<DeskProperty> | null>(null);
  const searching = !selected && query.trim().length >= 2;
  useEffect(() => {
    if (!searching) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskProperties(query)
        .then((r) => {
          if (!stale) setRes({ query, hits: r.properties, failed: false });
        })
        .catch(() => {
          if (!stale) setRes({ query, hits: [], failed: true });
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, searching]);
  // 今の検索語の結果だけ出す(打ち直し中に前の候補を押せないように)。
  const shown = hitsForQuery(res, query);
  return (
    <div className="space-y-1">
      <input
        data-guide="property"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="例: サンライズ 305 / 本町"
        aria-label="物件を探す"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
      />
      {searching && shown && shown.hits.length > 0 && <PropertyResults hits={shown.hits} onPick={onPick} />}
      {searching && shown && !shown.failed && shown.hits.length === 0 && (
        <p className="text-xs text-gray-500">見つかりません(しまった物件は出ません)</p>
      )}
      {searching && shown?.failed && <p className="text-xs text-rose-600">検索できませんでした(通信を確かめてください)</p>}
    </div>
  );
}
