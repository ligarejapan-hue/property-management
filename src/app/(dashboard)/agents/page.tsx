"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiErrorCode, fetchAgentDirectory, searchDeskAgents, type AgentDirectoryRow, type AgentHit } from "@/lib/api-client";
import { hitsForQuery, newAgentAction, splitNewAgentPhone, type SearchResult } from "@/lib/agent-inquiry/desk-form";
import { agentQueryReady } from "@/lib/agent-inquiry/agent-query";
import { PageHeader } from "@/components/ui/page-header";
import { SearchField } from "@/components/ui/search-field";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { AgentDirectoryRows, AgentSearchHits } from "@/components/agent-inquiry/agent-directory";
import { AgentCreateModal } from "@/components/agent-inquiry/agent-create-modal";

type Filter = "active" | "archived";
const FILTERS = [
  { key: "active", label: "名簿" },
  { key: "archived", label: "しまった業者" },
] as const;

/** 業者の名簿(設計 2026-09-28 §2.3)。電話帳型・会社の情報だけ。 */
export default function AgentsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("active");
  const [rows, setRows] = useState<AgentDirectoryRow[]>([]);
  // rows がどの絞り込みで読んだ行か。今の絞り込みと違う間は出さない(タブを替えた直後に別のタブの行を見せない)。
  const [rowsFilter, setRowsFilter] = useState<Filter | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  // 書けるかどうかはサーバーが返す(画面で権限表を読まない)。分かるまでは出さない側。
  const [canWrite, setCanWrite] = useState(false);
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<SearchResult<AgentHit> | null>(null);
  const [creating, setCreating] = useState(false);
  // 一覧の世代(絞り込み・読み直しで進む)。もっと見るの応答が古い世代なら捨てる。
  const genRef = useRef(0);
  const moreRef = useRef(-1);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    genRef.current += 1;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchAgentDirectory({ archived: filter === "archived" });
        if (cancelled) return;
        setRows(r.agents);
        setCursor(r.nextCursor);
        setCanWrite(r.canWrite);
        setRowsFilter(filter);
        setState("ok");
      } catch (e) {
        if (cancelled) return;
        const forbidden = apiErrorCode(e) === "FORBIDDEN";
        // 通信の失敗では書けるかどうかを変えない。権限なしのときだけ落とす。
        if (forbidden) setCanWrite(false);
        setState(forbidden ? "forbidden" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, reloadKey]);

  const loadMore = async () => {
    if (!cursor || moreRef.current === genRef.current) return;
    const gen = genRef.current;
    moreRef.current = gen;
    setLoadingMore(true);
    try {
      const r = await fetchAgentDirectory({ archived: filter === "archived", cursor });
      if (genRef.current !== gen) return;
      setRows((prev) => [...prev, ...r.agents]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (genRef.current === gen) setState(apiErrorCode(e) === "FORBIDDEN" ? "forbidden" : "error");
    } finally {
      // 世代が変わっていても「読み込み中」は戻す(押せないまま残さない)。
      setLoadingMore(false);
      if (moreRef.current === gen) moreRef.current = -1;
    }
  };

  // 検索(代表電話・携帯・会社名)。打ち終わって 250ms 後に探す(受付の窓の業者の欄と同じ)。
  const searching = agentQueryReady(query);
  useEffect(() => {
    if (!searching) return;
    let stale = false;
    const t = setTimeout(() => {
      searchDeskAgents(query)
        .then((r) => {
          if (!stale) setRes({ query, hits: r.agents, failed: false });
        })
        .catch((e) => {
          if (stale) return;
          if (apiErrorCode(e) === "FORBIDDEN") setState("forbidden");
          else setRes({ query, hits: [], failed: true });
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, searching]);
  // 今の検索語の結果だけ出す(打ち直している間に前の候補を見せない)。
  const shown = hitsForQuery(res, query);
  // 探し終える前に「新しく登録」を出すと、名簿にある業者を二重に作れてしまう。
  const createAction = newAgentAction({ selected: false, searching, shown });

  return (
    // 検索の結果に問い合わせ者の名前(個人情報)が出るので画面保護の対象にする。
    <div data-pii-protected data-pii-surface="dashboard" className="mx-auto max-w-4xl">
      <PageHeader title="業者の名簿" description="反響をくれた不動産会社の電話帳です。会社名か電話番号で探せます。" />
      {state === "forbidden" ? (
        <p className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
          反響の受付の権限がありません。管理者にお問い合わせください。
        </p>
      ) : (
        <div className="space-y-3">
          <SearchField
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例: ○○不動産 / 0312345 / 09012"
            aria-label="業者を探す"
          />
          {searching ? (
            <div className="space-y-2">
              {shown == null && <p className="text-sm text-gray-500 dark:text-gray-400">探しています…</p>}
              {shown?.failed && <p className="text-sm text-rose-600 dark:text-rose-400">検索できませんでした(通信を確かめてください)。</p>}
              {shown && !shown.failed && shown.hits.length > 0 && <AgentSearchHits hits={shown.hits} />}
              {shown && !shown.failed && shown.hits.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  見つかりません(しまった業者は検索に出ません。「しまった業者」の一覧で探してください)。
                </p>
              )}
              {canWrite && createAction !== "none" && (
                <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                  {createAction === "empty" ? "＋ 名簿にない業者を新しく登録" : "上の候補に無い(別の支店など)ときだけ、新しく登録"}
                </Button>
              )}
            </div>
          ) : (
            <>
              <Tabs idBase="agent-directory" tabs={FILTERS} active={filter} onChange={setFilter} />
              <div {...tabPanelProps("agent-directory", filter)} className="space-y-2">
                {state === "error" && (
                  <div role="alert" className="flex items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200">
                    <span>読み込めませんでした。</span>
                    <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                      もう一度読む
                    </Button>
                  </div>
                )}
                {rowsFilter !== filter ? (
                  state !== "error" && <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>
                ) : (
                  <AgentDirectoryRows rows={rows} />
                )}
                {rowsFilter === filter && cursor != null && (
                  <Button variant="secondary" className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? "読み込み中…" : "もっと見る"}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {creating && (
        <AgentCreateModal
          // 電話番号らしい語で探していたら代表電話の欄へ(携帯は会社の代表電話には入れない)。
          initialPhone={splitNewAgentPhone(query).agentPhone}
          onClose={() => setCreating(false)}
          onCreated={(hit) => {
            setCreating(false);
            router.push(`/agents/${hit.id}`);
          }}
        />
      )}
    </div>
  );
}
