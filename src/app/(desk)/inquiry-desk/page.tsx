"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiErrorCode,
  fetchAgentInquiries,
  fetchAgentInquiryCounts,
  fetchUpcomingViewings,
  fetchUsers,
  type InquiryStatusKey,
  type InquiryView,
  type UpcomingViewing,
} from "@/lib/api-client";
import { EMPTY_DESK_FORM, nextDeskGuideStep, type DeskFormState } from "@/lib/agent-inquiry/desk-form";
import InquiryForm from "@/components/agent-inquiry/inquiry-form";
import { UpcomingViewingsView } from "@/components/agent-inquiry/upcoming-viewings";
import { InquiryListView } from "@/components/agent-inquiry/inquiry-list";
import InquiryDetail from "@/components/agent-inquiry/inquiry-detail";
import DeskStepGuide from "@/components/agent-inquiry/desk-step-guide";
import { DESK_OPEN_COUNT_EVENT } from "@/components/agent-inquiry/desk-shell";

/** 受付の窓(設計 2026-09-28 §2.1)。上から 今日・明日の内見 → 登録フォーム → 一覧(広い画面は右列)。 */
export default function InquiryDeskPage() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingViewing[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [tab, setTab] = useState<InquiryStatusKey>("open");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<InquiryView[]>([]);
  // items がどの絞り込みで読んだ行か。今の絞り込みと違う間は出さない(タブを替えた直後・読み込み失敗時に
  // 別のタブの行を見せない・@codex #459 R4)。
  const [listKey, setListKey] = useState<string | null>(null);
  const filterKey = `${tab}|${mine}`;
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // 403 以外の読み込み失敗。「ありません」と見分けがつくよう知らせる(内見の見落としを防ぐ・@codex #459 R1)。
  const [loadError, setLoadError] = useState(false);
  const [formState, setFormState] = useState<DeskFormState>(EMPTY_DESK_FORM);

  const onError = useCallback((e: unknown) => {
    if (apiErrorCode(e) === "FORBIDDEN") setForbidden(true);
    else setLoadError(true);
  }, []);

  // 読み直しの合図(保存・変更のたびに1つ進める)。取得は下の effect がまとめて行う。
  const [reloadKey, setReloadKey] = useState(0);
  const reloadAll = useCallback(() => setReloadKey((k) => k + 1), []);

  // 一覧の世代(タブ・自分の担当だけ・読み直しで進む)。もっと見るの応答が古い世代なら捨てる。
  const listGenRef = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    listGenRef.current += 1;
    let cancelled = false;
    (async () => {
      try {
        // 担当者の一覧も同じ読み込みに入れる(失敗を空の一覧に見せず、知らせて読み直せる・@codex #459 R3)。
        const [list, up, counts, us] = await Promise.all([
          fetchAgentInquiries({ status: tab, assignee: mine ? "me" : undefined }),
          fetchUpcomingViewings(),
          fetchAgentInquiryCounts(),
          fetchUsers(),
        ]);
        if (cancelled) return;
        setLoadError(false);
        setUsers(us.data.map((u) => ({ id: u.id, name: u.name })));
        setItems(list.items);
        setCursor(list.nextCursor);
        setListKey(`${tab}|${mine}`);
        setUpcoming(up.viewings);
        setOpenCount(counts.open);
        window.dispatchEvent(new CustomEvent(DESK_OPEN_COUNT_EVENT, { detail: counts.open }));
      } catch (e) {
        if (!cancelled) onError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, mine, reloadKey, onError]);

  const loadMore = async () => {
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const gen = listGenRef.current;
    try {
      const r = await fetchAgentInquiries({ status: tab, assignee: mine ? "me" : undefined, cursor });
      // 待っている間にタブ・絞り込みを替えた/読み直した=古い応答なので混ぜない(@codex #459 R2)。
      if (listGenRef.current !== gen) return;
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (listGenRef.current === gen) onError(e);
    } finally {
      loadingMoreRef.current = false;
    }
  };

  if (forbidden) {
    return (
      <p className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
        反響の受付の権限がありません。管理者にお問い合わせください。
      </p>
    );
  }
  return (
    // 問い合わせ者の名前・携帯・メール(PII)を出すので画面保護の対象にする。
    <div data-pii-protected data-pii-surface="dashboard" className="grid gap-4 lg:grid-cols-2">
      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 lg:col-span-2 dark:bg-rose-950 dark:text-rose-200">
          <span>読み込めませんでした。一覧と今日・明日の内見が最新ではありません。</span>
          <button type="button" onClick={reloadAll} className="shrink-0 rounded border border-rose-300 px-2 py-0.5 text-xs">
            もう一度読む
          </button>
        </div>
      )}
      <div className="space-y-3">
        <UpcomingViewingsView viewings={upcoming} />
        <DeskStepGuide step={nextDeskGuideStep(formState)} />
        <InquiryForm users={users} onSaved={reloadAll} onStateChange={setFormState} />
      </div>
      <div>
        <InquiryListView
          tab={tab}
          onTab={setTab}
          mine={mine}
          onMine={setMine}
          items={listKey === filterKey ? items : []}
          openCount={openCount}
          onOpen={setOpenId}
          hasMore={listKey === filterKey && cursor != null}
          onMore={loadMore}
        />
      </div>
      {openId && <InquiryDetail inquiryId={openId} users={users} onClose={() => setOpenId(null)} onChanged={reloadAll} />}
    </div>
  );
}
