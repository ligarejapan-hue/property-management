"use client";

import { useEffect, useRef, useState } from "react";
import { agentLabel, hitsForQuery, newAgentAction, type SearchResult } from "@/lib/agent-inquiry/desk-form";
import { useDeskAccess } from "./desk-access";
import { agentQueryReady } from "@/lib/agent-inquiry/agent-query";
import { isPhoneCharsOnly } from "@/lib/phone-format-jp";
import { adoptRegistryAgent, searchDeskAgents, type AgentHit, type RegistryHit } from "@/lib/api-client";

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
              {agentLabel(h)}
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

/**
 * 名簿に無い会社の候補(国交省の一覧から・2026-10-03)。押すと名簿へ写してから選んだ状態になる。
 * 業者の会社情報(代表電話・免許番号)だけ=個人の情報は無い。
 */
export function RegistryResults({
  hits,
  busyId,
  onPick,
}: {
  hits: RegistryHit[];
  busyId: string | null;
  onPick: (h: RegistryHit) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-500">名簿に無い会社(国交省の一覧から)</p>
      <ul className="divide-y divide-gray-100 rounded-md border border-dashed border-gray-300 bg-white dark:divide-gray-800 dark:border-gray-600 dark:bg-gray-900">
        {hits.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onPick(h)}
              disabled={busyId !== null}
              className="block w-full px-3 py-2 text-left hover:bg-teal-50 disabled:opacity-60 dark:hover:bg-gray-800"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {h.companyName}
                <span className="rounded border border-gray-300 px-1 text-[10px] font-normal text-gray-500 dark:border-gray-600">
                  国交省の一覧
                </span>
              </span>
              <span className="block text-xs text-gray-500">
                代表 {h.phone} ・ {h.licenseLabel}
                {busyId === h.id && " ・ 名簿に入れています…"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
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
  const [res, setRes] = useState<(SearchResult<AgentHit> & { registry: RegistryHit[] }) | null>(null);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  // 検索語が変わるたびに増える番号(写す返事が届いたときに、押してから一度も変わっていないかを確かめる)。
  // 語そのものの比較だと、打ってから消して元の語に戻したときに古い返事で選んでしまう(@codex #477)。
  const queryGen = useRef(0);
  useEffect(() => {
    queryGen.current += 1;
  }, [query]);
  const searching = !selected && agentQueryReady(query);
  const { readDenied } = useDeskAccess();
  useEffect(() => {
    if (!searching) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskAgents(query, { registry: true })
        .then((r) => {
          if (!stale) setRes({ query, hits: r.agents, failed: false, registry: r.registry ?? [] });
        })
        .catch((e) => {
          // ログイン切れ・権限なしはただの検索失敗にせず、窓ごと隠す(@codex #459 R20)。
          if (readDenied(e)) return;
          if (!stale) setRes({ query, hits: [], failed: true, registry: [] });
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, searching, readDenied]);
  // 今の検索語の結果だけ出す(打ち直し中に前の候補を押せないように)。
  const shown = hitsForQuery(res, query);
  const registryShown = shown && res ? res.registry : [];
  // 一覧の候補も「候補がある」に数える(候補を見ずに新しく登録して、同じ会社を手で作らない)。
  const createAction = newAgentAction({
    selected: selected != null,
    searching,
    shown: shown ? { hits: [...shown.hits, ...registryShown], failed: shown.failed } : null,
  });
  const pickRegistry = (h: RegistryHit) => {
    const asked = queryGen.current;
    setAdoptingId(h.id);
    setAdoptError(null);
    adoptRegistryAgent(h.id)
      .then((r) => {
        // 写している間に検索語を打ち直していたら、古い返事で選ばない(別の業者に反響を付けない・@codex #477)。
        // 名簿へは写っているので、もう一度探せば名簿の候補として出る。
        if (queryGen.current !== asked) return;
        onPick(r.agent);
      })
      .catch((e) => {
        if (readDenied(e)) return;
        setAdoptError("名簿に入れられませんでした。もう一度探してから選んでください。");
      })
      .finally(() => setAdoptingId(null));
  };
  return (
    <div className="space-y-1">
      <input
        data-guide="agent"
        value={query}
        onChange={(e) => {
          // 打った瞬間に番号を進める(描画や effect を待たない=返事が描画の直前に届いても古い返事で選ばない・@codex #477)
          queryGen.current += 1;
          onQuery(e.target.value);
        }}
        placeholder="例: 0312345 / 09012 / ○○不動産"
        aria-label="業者を探す"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
      />
      {searching && shown && shown.hits.length > 0 && <AgentResults hits={shown.hits} onPick={onPick} />}
      {searching && registryShown.length > 0 && (
        <RegistryResults hits={registryShown} busyId={adoptingId} onPick={pickRegistry} />
      )}
      {adoptError && <p className="text-xs text-rose-600">{adoptError}</p>}
      {searching && shown?.failed && <p className="text-xs text-rose-600">検索できませんでした(通信を確かめてください)</p>}
      {/* 探し終えてから出す=候補を見ずに押して、名簿にある業者を二重に作らない(@codex #459 R21)。 */}
      {createAction === "empty" && (
        <button type="button" onClick={onCreateNew} className="text-sm text-teal-700 underline dark:text-teal-300">
          ＋ 名簿にない業者を新しく登録
        </button>
      )}
      {createAction === "hasHits" && (
        <button type="button" onClick={onCreateNew} className="text-xs text-gray-500 underline">
          上の候補に無い(別の支店など)ときだけ、新しく登録
        </button>
      )}
      {!selected && !searching && (
        <p className="text-xs text-gray-500">
          {isPhoneCharsOnly(query)
            ? "電話番号は7桁以上入れると探します。"
            : "会社名(2文字以上)か電話番号(7桁以上)で探すと、名簿に無いときは新しく登録できます。"}
        </p>
      )}
    </div>
  );
}
