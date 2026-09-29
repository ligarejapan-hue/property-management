"use client";

import { useEffect, useState } from "react";
import { hitsForQuery, type SearchResult } from "@/lib/agent-inquiry/desk-form";
import { useDeskAccess } from "./desk-access";
import { searchDeskAgents, type AgentHit } from "@/lib/api-client";

/** 業者の候補(見た目)。携帯で当たったときは前回の問い合わせ者の名前を添える。 */
export function AgentResults({ hits, onPick }: { hits: AgentHit[]; onPick: (a: AgentHit) => void }) {
  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-700 dark:bg-gray-900">
      {hits.map((h) => (
        <li key={h.id}>
          <button
            type="button"
            onClick={() => onPick(h)}
            className="block w-full px-3 py-2 text-left hover:bg-teal-50 dark:hover:bg-gray-800"
          >
            <span className="block text-sm font-medium">
              {h.branchName ? `${h.companyName} ${h.branchName}` : h.companyName}
            </span>
            <span className="block text-xs text-gray-500">
              代表 {h.phone}
              {/* 画面保護はボタンの中を外で見ないので、個人情報には自前の印を付ける(@codex #459 R4)。 */}
              {h.lastContact?.name && (
                <span data-pii-protected="true" data-pii-surface="dashboard">{` ・ 前回 ${h.lastContact.name}様`}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 業者を探す1つの欄(代表電話・携帯・会社名のどれでも・設計 §2.2-1)。打ち終わって 250ms 後に探す。 */
export function AgentPicker({
  query,
  selected,
  onQuery,
  onPick,
  onCreateNew,
}: {
  query: string;
  selected: AgentHit | null;
  onQuery: (v: string) => void;
  onPick: (a: AgentHit) => void;
  onCreateNew: () => void;
}) {
  const [res, setRes] = useState<SearchResult<AgentHit> | null>(null);
  const searching = !selected && query.trim().length >= 2;
  const { readDenied } = useDeskAccess();
  useEffect(() => {
    if (!searching) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskAgents(query)
        .then((r) => {
          if (!stale) setRes({ query, hits: r.agents, failed: false });
        })
        .catch((e) => {
          // ログイン切れ・権限なしはただの検索失敗にせず、窓ごと隠す(@codex #459 R20)。
          if (readDenied(e)) return;
          if (!stale) setRes({ query, hits: [], failed: true });
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, searching, readDenied]);
  // 今の検索語の結果だけ出す(打ち直し中に前の候補を押せないように)。
  const shown = hitsForQuery(res, query);
  return (
    <div className="space-y-1">
      <input
        data-guide="agent"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="例: 0312345 / 09012 / ○○不動産"
        aria-label="業者を探す"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
      />
      {searching && shown && shown.hits.length > 0 && <AgentResults hits={shown.hits} onPick={onPick} />}
      {searching && shown?.failed && <p className="text-xs text-rose-600">検索できませんでした(通信を確かめてください)</p>}
      {!selected && (
        <button type="button" onClick={onCreateNew} className="text-sm text-teal-700 underline dark:text-teal-300">
          ＋ 名簿にない業者を新しく登録
        </button>
      )}
    </div>
  );
}
