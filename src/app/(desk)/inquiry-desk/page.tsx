"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  EMPTY_DESK_FORM,
  donePeriodDays,
  nextDeskGuideStep,
  type DeskFormState,
  type DonePeriodKey,
} from "@/lib/agent-inquiry/desk-form";
import InquiryForm from "@/components/agent-inquiry/inquiry-form";
import { UpcomingViewingsView } from "@/components/agent-inquiry/upcoming-viewings";
import { InquiryListView } from "@/components/agent-inquiry/inquiry-list";
import InquiryDetail from "@/components/agent-inquiry/inquiry-detail";
import DeskStepGuide from "@/components/agent-inquiry/desk-step-guide";
import { DESK_OPEN_COUNT_EVENT } from "@/components/agent-inquiry/desk-shell";
import { DeskAccessContext, makeDeskAccess } from "@/components/agent-inquiry/desk-access";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import { hasPermission } from "@/lib/permissions";
import { notifyInquiryChanged } from "@/lib/agent-inquiry/desk-sync";

/** 受付の窓(設計 2026-09-28 §2.1)。上から 今日・明日の内見 → 登録フォーム → 一覧(広い画面は右列)。 */
export default function InquiryDeskPage() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingViewing[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [tab, setTab] = useState<InquiryStatusKey>("open");
  const [mine, setMine] = useState(false);
  // 対応済みタブの期間(設計 §2.1 の「直近30日を既定表示」)。未対応・対応中には効かない。
  const [period, setPeriod] = useState<DonePeriodKey>("30");
  const [items, setItems] = useState<InquiryView[]>([]);
  // items がどの絞り込みで読んだ行か。今の絞り込みと違う間は出さない(タブを替えた直後・読み込み失敗時に
  // 別のタブの行を見せない・@codex #459 R4)。
  const [listKey, setListKey] = useState<string | null>(null);
  const filterKey = `${tab}|${mine}|${period}`;
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // API が 403 を返したときの権限の値。権限を読み直せば(別の配列になり)自然に解ける=外されて戻された
  // 権限で窓が永久に止まらない(@codex #459 R16)。
  const [forbiddenFor, setForbiddenFor] = useState<unknown>(undefined);
  // API が 401 を返した(ログインが切れた・ユーザーが消された)。権限なしと同じく中身を隠し、ログインし直しへ
  // 案内する(@codex #459 R19)。ログインし直すと窓ごと読み直すので、ここで戻す必要はない。
  const [sessionLost, setSessionLost] = useState(false);
  // 開いたままの窓で閲覧権限を外されたら、画面保護が読み直す権限を見て中身を消す(@codex #459 R10)。
  const { permissions, permissionsLoading, permissionsError, refetchPermissions } = useScreenProtection();
  // 権限の鮮度の3点セット(permission-freshness-pattern.test.ts の規約・建物詳細と同じ形):
  // (1) 進入あたり最大1回だけ再確認 (2) 再確認が終わるまでは pending で開始 (3) pending/loading は出さない側へ。
  const permissionsRefreshRequestedRef = useRef(false);
  const permissionsLoadingAtMountRef = useRef<boolean | null>(null);
  if (permissionsLoadingAtMountRef.current === null) {
    permissionsLoadingAtMountRef.current = permissionsLoading;
  }
  const [permissionsRefreshPending, setPermissionsRefreshPending] = useState(() => !permissionsLoading);
  const forbidden = forbiddenFor !== undefined && forbiddenFor === permissions;
  const permissionsRef = useRef(permissions);
  useEffect(() => {
    permissionsRef.current = permissions;
  }, [permissions]);
  useEffect(() => {
    if (permissionsRefreshRequestedRef.current) return;
    // provider の取得が進行中なら完了を待つ(同時 2 本にしない)。
    if (permissionsLoading) return;
    if (permissionsLoadingAtMountRef.current === true && permissions !== null) {
      // mount 時に進行中だった取得が成功 → 見ている値は最新。
      permissionsRefreshRequestedRef.current = true;
      setPermissionsRefreshPending(false);
      return;
    }
    permissionsRefreshRequestedRef.current = true;
    setPermissionsRefreshPending(true);
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [permissionsLoading, permissions, refetchPermissions]);
  const permissionsSettled = !permissionsLoading && !permissionsRefreshPending;
  const revoked = permissionsSettled && permissions != null && !hasPermission(permissions, "agent_inquiry", "read");
  // 書く権限が無い人には登録・変更を出さない(押してから 403 にしない・@codex #459 R12)。
  const canWrite = permissionsSettled && permissions != null && hasPermission(permissions, "agent_inquiry", "write");
  const bodyVisible = permissionsSettled && permissions != null && !revoked && !forbidden && !sessionLost;
  // 中身を出さない間は、見出しの未対応件数も消す(枠は画面の外にあるので知らせる)。
  useEffect(() => {
    if (!bodyVisible) window.dispatchEvent(new CustomEvent(DESK_OPEN_COUNT_EVENT, { detail: null }));
  }, [bodyVisible]);
  // 403 以外の読み込み失敗。「ありません」と見分けがつくよう知らせる(内見の見落としを防ぐ・@codex #459 R1)。
  const [loadError, setLoadError] = useState(false);
  const [formState, setFormState] = useState<DeskFormState>(EMPTY_DESK_FORM);

  // 子(検索・登録・詳細)の 401/403 の扱い。読み込みは画面ごと隠し、書き込みの 403 は権限を読み直す(@codex #459 R20)。
  const deskAccess = useMemo(
    () =>
      makeDeskAccess({
        sessionLost: () => setSessionLost(true),
        readForbidden: () => setForbiddenFor(permissionsRef.current),
        writeForbidden: () => void refetchPermissions(),
      }),
    [refetchPermissions],
  );

  const onError = useCallback((e: unknown) => {
    const code = apiErrorCode(e);
    if (code === "FORBIDDEN") setForbiddenFor(permissionsRef.current);
    else if (code === "UNAUTHORIZED") setSessionLost(true);
    else setLoadError(true);
  }, []);

  // 読み直しの合図(保存・変更のたびに1つ進める)。取得は下の effect がまとめて行う。
  // メイン画面(物件の反響欄・ホームの件数)にも「変わった」と知らせる。
  const [reloadKey, setReloadKey] = useState(0);
  const reloadAll = useCallback(() => {
    setReloadKey((k) => k + 1);
    notifyInquiryChanged();
  }, []);

  // 一覧の世代(タブ・自分の担当だけ・読み直しで進む)。もっと見るの応答が古い世代なら捨てる。
  const listGenRef = useRef(0);
  // もっと見るを読んでいる一覧の世代(-1=読んでいない)。世代ごとの鍵なので、タブを替えた後の
  // もっと見るは古い読み込みに邪魔されない(@codex #459 R10)。
  const loadingMoreRef = useRef(-1);

  useEffect(() => {
    // 中身を出していない間は読まない。見えなくなったら途中の読み込みは cancelled で結果(件数)を捨てる
    // (@codex #459 R13: 権限を外された後に件数が見出しに出直さないように)。
    if (!bodyVisible) return;
    listGenRef.current += 1;
    let cancelled = false;
    (async () => {
      try {
        // 担当者の一覧も同じ読み込みに入れる(失敗を空の一覧に見せず、知らせて読み直せる・@codex #459 R3)。
        const [list, up, counts, us] = await Promise.all([
          fetchAgentInquiries({ status: tab, assignee: mine ? "me" : undefined, days: donePeriodDays(tab, period) }),
          fetchUpcomingViewings(),
          fetchAgentInquiryCounts(),
          fetchUsers(),
        ]);
        if (cancelled) return;
        setLoadError(false);
        setUsers(us.data.map((u) => ({ id: u.id, name: u.name })));
        setItems(list.items);
        setCursor(list.nextCursor);
        setListKey(`${tab}|${mine}|${period}`);
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
  }, [tab, mine, period, reloadKey, onError, bodyVisible]);

  const loadMore = async () => {
    if (!cursor || loadingMoreRef.current === listGenRef.current) return;
    const gen = listGenRef.current;
    loadingMoreRef.current = gen;
    try {
      const r = await fetchAgentInquiries({ status: tab, assignee: mine ? "me" : undefined, days: donePeriodDays(tab, period), cursor });
      // 待っている間にタブ・絞り込みを替えた/読み直した=古い応答なので混ぜない(@codex #459 R2)。
      if (listGenRef.current !== gen) return;
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (listGenRef.current === gen) onError(e);
    } finally {
      if (loadingMoreRef.current === gen) loadingMoreRef.current = -1;
    }
  };

  // 権限がまだ分からない/読めなかった(null)間は中身を出さない=失敗した再検証で古い中身を残さない
  // (@codex #459 R11)。
  if (sessionLost) {
    return (
      <div className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
        <p className="mb-2">ログインが切れました。ログインし直してください。</p>
        <a
          href={`/login?callbackUrl=${encodeURIComponent("/inquiry-desk")}`}
          className="inline-block rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600"
        >
          ログイン画面へ
        </a>
      </div>
    );
  }
  if (permissions == null || !permissionsSettled) {
    return (
      <div className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
        {permissionsSettled && permissionsError ? (
          <>
            <p className="mb-2">権限を確かめられませんでした。</p>
            <button type="button" onClick={() => void refetchPermissions()} className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700">
              もう一度確かめる
            </button>
          </>
        ) : (
          <p>権限を確かめています…</p>
        )}
      </div>
    );
  }
  if (forbidden || revoked) {
    return (
      <div className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
        <p className="mb-2">反響の受付の権限がありません。管理者にお問い合わせください。</p>
        {/* 権限を戻してもらったら、ここで確かめ直せる(読み直すと表示が戻る)。 */}
        <button type="button" onClick={() => void refetchPermissions()} className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700">
          もう一度確かめる
        </button>
      </div>
    );
  }
  return (
    // 問い合わせ者の名前・携帯・メール(PII)を出すので画面保護の対象にする。
    <DeskAccessContext.Provider value={deskAccess}>
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
          {canWrite ? (
            <>
              <DeskStepGuide step={nextDeskGuideStep(formState)} />
              <InquiryForm users={users} onSaved={reloadAll} onStateChange={setFormState} />
            </>
          ) : (
            <p className="rounded-md bg-white p-3 text-sm text-gray-500 dark:bg-gray-900">
              反響を登録・変更する権限がありません(見ることはできます)。
            </p>
          )}
        </div>
        <div>
          <InquiryListView
            tab={tab}
            onTab={setTab}
            period={period}
            onPeriod={setPeriod}
            mine={mine}
            onMine={setMine}
            items={listKey === filterKey ? items : []}
            openCount={openCount}
            onOpen={setOpenId}
            hasMore={listKey === filterKey && cursor != null}
            onMore={loadMore}
          />
        </div>
        {/* 反響の id で作り直す=前に押した反響の遅い応答で、別の反響の詳細が開かない(@codex #459 R11)。 */}
        {openId && (
          <InquiryDetail
            key={openId}
            inquiryId={openId}
            users={users}
            onClose={() => setOpenId(null)}
            onChanged={reloadAll}
            canWrite={canWrite}
            onAccessLost={(e) => {
              setOpenId(null);
              onError(e);
            }}
          />
        )}
      </div>
    </DeskAccessContext.Provider>
  );
}
