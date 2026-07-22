"use client";

/**
 * 現地調査マップ Phase 1-F-1: 巡回開始 / 終了 UI と active session 復元。
 *
 * - mount 時に `GET /api/field-survey/sessions?status=active` で自分の
 *   active session を取得して復元する。
 * - 巡回開始: 注意文言 modal → POST /api/field-survey/sessions
 *   - 409 ACTIVE_SESSION_EXISTS は再取得で UI 整合
 * - 巡回終了: 確認 modal → PATCH /api/field-survey/sessions/[id]
 *   - 409 INVALID_STATE は再取得で UI 整合
 *
 * 今回スコープ外 (Phase 1-F-2 以降で実装):
 *   - navigator.geolocation 利用 (本ファイルでは一切呼ばない)
 *   - TrackPoint 送信 / route polyline / 現在位置 marker
 *   - Wake Lock / IndexedDB / localStorage / sessionStorage 保存
 *
 * privacy:
 *   - API response を console に出さない
 *   - session detail / PII / lat/lng / API key / env 値を console に出さない
 *   - error message に server 内部 message を流出させない (汎用文言に変換)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyTripApiResponse,
  extractApiErrorCode,
  formatElapsed,
  formatStaleDuration,
  isSessionStale,
  pickOwnActiveSession,
  STALE_CONFIRM_THRESHOLD_MS,
  tripOutcomeMessage,
  type ActiveSessionLike,
} from "@/lib/field-survey-trip-util";

interface TripControlsProps {
  currentUserId: string;
  /**
   * Phase 1-F-2: 親 (FieldSurveyMap) が active session の有無を知るための
   * 通知 callback。session 詳細 (lat/lng/memo) は持たない最小情報のみ。
   * 未指定なら呼ばれない (Phase 1-F-1 互換)。
   */
  onActiveSessionChange?: (session: ActiveSessionLike | null) => void;
  /**
   * Phase 1-F-2: 巡回終了 API を叩く直前に await される hook。
   * 親側で位置記録 (watchPosition / flush timer / 残 buffer chunk flush) を
   * 確実に止めるために使う。throw されても巡回終了処理は継続する (catch 握り潰し)。
   *
   * Codex P1: 戻り値 false の場合、未送信 buffer が残っているため
   * session end PATCH を呼ばずに active 状態へ戻し、ユーザーに再送信を促す。
   * void / true / undefined / 例外時は従来どおり PATCH に進む。
   */
  onBeforeSessionEnd?: () => Promise<boolean | void> | boolean | void;
}

type Phase =
  | "loading" // 初期 active session 取得中
  | "idle" // 巡回未開始
  | "confirmStart" // 注意文言 modal 表示中
  | "starting" // POST sessions 中
  | "active" // 巡回中
  | "confirmEnd" // 終了確認 modal 表示中
  | "confirmStaleEnd" // B-7: 放置 session の終了確認 modal 表示中
  | "ending"; // PATCH sessions 中

export default function TripControls({
  currentUserId,
  onActiveSessionChange,
  onBeforeSessionEnd,
}: TripControlsProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<ActiveSessionLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());
  // GET (active 再取得) と mutation (POST/PATCH) で AbortController を分離。
  // 同時並行の retry や connect 時に互いを誤って中断させない。
  const activeFetchAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  // Codex P2 (unmount safety): unmount 後の setState を抑止する。
  // useEffect cleanup で false に倒し、各 handler の state 更新前に確認する。
  const mountedRef = useRef(true);
  // B-7: 放置 session の終了確認は同一 session につき 1 回だけ出す
  // (conflict 後の再取得などで繰り返し聞き直さない)。
  const stalePromptedRef = useRef<string | null>(null);
  // B-7 (@codex R10): 「巡回を続ける」を選んだ session id。続行直後の touch が
  // 失敗 (オフライン等) しても、終了直前に再 touch して「続行したのに endedAt が
  // 続行前へ巻き戻る」ことを防ぐための印。
  const resumedRef = useRef<string | null>(null);

  const isAbortError = (err: unknown): boolean =>
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError";

  const fetchActiveSession = useCallback(async (): Promise<void> => {
    if (activeFetchAbortRef.current) activeFetchAbortRef.current.abort();
    const ac = new AbortController();
    activeFetchAbortRef.current = ac;
    try {
      // Codex P2: read_all/manage 持ちのユーザーが他人 session を多数引いて
      // 自分の active が limit 切れに落ちる事故を防ぐため、staffUserId で
      // 自分に絞る。non-read_all ユーザーは API 側で own 強制されるが、
      // 全 role で URL レベルでも自分のみを要求する。limit=1 で十分。
      const url =
        `/api/field-survey/sessions?status=active` +
        `&staffUserId=${encodeURIComponent(currentUserId)}&limit=1`;
      const res = await fetch(url, {
        signal: ac.signal,
        credentials: "same-origin",
      });
      if (!mountedRef.current) return;
      const body = (await res.json().catch(() => null)) as
        | { data?: ActiveSessionLike[] }
        | null;
      if (!mountedRef.current) return;
      const outcome = classifyTripApiResponse(
        res.status,
        extractApiErrorCode(body),
      );
      if (outcome.kind !== "ok") {
        setError(tripOutcomeMessage(outcome));
        setSession(null);
        setPhase("idle");
        return;
      }
      // pickOwnActiveSession は server filter 漏れに対する防御として残す。
      const own = pickOwnActiveSession(body?.data ?? [], currentUserId);
      setSession(own);
      // B-7: 終了し忘れの放置 session (最終活動から 12h 超) を復元したときは、
      // 巡回中表示へ戻す前に終了するかどうかを確認する (同一 session 1 回のみ)。
      // 放置判定は最終活動時刻ベース (@codex R3・記録が続いている session に出さない)。
      if (
        own &&
        stalePromptedRef.current !== own.id &&
        isSessionStale(
          own.updatedAt ?? own.startedAt,
          new Date(),
          STALE_CONFIRM_THRESHOLD_MS,
        )
      ) {
        stalePromptedRef.current = own.id;
        setPhase("confirmStaleEnd");
      } else {
        setPhase(own ? "active" : "idle");
      }
      setError(null);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current) return;
      setError("巡回 session の取得に失敗しました。");
      setSession(null);
      setPhase("idle");
    }
  }, [currentUserId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchActiveSession();
    return () => {
      mountedRef.current = false;
      if (activeFetchAbortRef.current) activeFetchAbortRef.current.abort();
      // Codex P2: start/end mutation も unmount で abort する。
      if (mutationAbortRef.current) mutationAbortRef.current.abort();
    };
  }, [fetchActiveSession]);

  // 巡回中の経過時間表示用 (1 秒 tick)
  useEffect(() => {
    if (phase !== "active") return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Phase 1-F-2: active session の有無を親に通知。
  // session detail (memo / lat / lng) は持たないが、親側でも PII を扱わない前提。
  useEffect(() => {
    if (!onActiveSessionChange) return;
    onActiveSessionChange(session);
  }, [session, onActiveSessionChange]);

  const startSession = useCallback(async () => {
    setPhase("starting");
    setError(null);
    // 並行起動の mutation を中断し、AbortController を新規発行。
    if (mutationAbortRef.current) mutationAbortRef.current.abort();
    const ac = new AbortController();
    mutationAbortRef.current = ac;
    try {
      const res = await fetch("/api/field-survey/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ac.signal,
      });
      if (!mountedRef.current) return;
      const body = (await res.json().catch(() => null)) as
        | { data?: ActiveSessionLike }
        | null;
      if (!mountedRef.current) return;
      const outcome = classifyTripApiResponse(
        res.status,
        extractApiErrorCode(body),
      );
      if (outcome.kind === "ok" && body?.data) {
        setSession(body.data);
        setPhase("active");
        return;
      }
      // 409 ACTIVE_SESSION_EXISTS は active 再取得 (currentUserId filter 付き) で UI 整合
      if (outcome.kind === "conflict_active") {
        setError(tripOutcomeMessage(outcome));
        await fetchActiveSession();
        return;
      }
      setError(tripOutcomeMessage(outcome));
      setPhase("idle");
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current) return;
      setError("巡回開始に失敗しました。");
      setPhase("idle");
    }
  }, [fetchActiveSession]);

  // B-7 (@codex R6/R7): 放置確認で「巡回を続ける」を選んだことも巡回の活動
  // として記録する (活動記録専用の touch PATCH で updatedAt だけを進める。
  // memo 送信で代用すると一覧 API が memo を返さないため既存 memo を消す)。
  // これが無いと、続行後に点・ピン無しで終了したとき server 側で stale 扱いの
  // まま endedAt が続行前の時刻へ巻き戻る。失敗しても続行自体は妨げない。
  const touchSession = useCallback(
    async (target: ActiveSessionLike) => {
      try {
        const res = await fetch(
          `/api/field-survey/sessions/${encodeURIComponent(target.id)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ touch: true }),
          },
        );
        if (!mountedRef.current) return;
        if (res.status === 409) {
          // 並行で終了済み (@codex R9)。終了済み session を巡回中として使い
          // 続けないよう、状態を取り直して UI を整合させる。
          await fetchActiveSession();
        }
      } catch {
        // best effort (オフライン等)。続行操作はローカルで成立させる。
      }
    },
    [fetchActiveSession],
  );

  const endSession = useCallback(
    async (target: ActiveSessionLike) => {
      setPhase("ending");
      setError(null);
      // Phase 1-F-2: session PATCH の前に位置記録 (watchPosition / flush
      // timer / 残 buffer chunk flush) を停止する。throw は握り潰す。
      // Codex P1: 戻り値が明示的に false の場合 = 未送信 buffer が残っている。
      // session end PATCH を呼ばず active 状態へ戻し、ユーザーに再送信を促す。
      if (onBeforeSessionEnd) {
        let beforeOk: boolean | void = undefined;
        try {
          beforeOk = await onBeforeSessionEnd();
        } catch {
          // 終了前 stop の失敗で巡回終了を阻まない (従来挙動)
        }
        if (!mountedRef.current) return;
        if (beforeOk === false) {
          setError(
            "未送信の位置情報が残っているため、巡回終了前に再度送信してください。",
          );
          setPhase("active");
          return;
        }
      }
      // B-7 (@codex R10): 続行済み session の終了は、直前に活動 touch を挟んで
      // server の stale 判定を解除する (続行時の touch が失敗していても、ここで
      // 記録されれば endedAt は now になり、続行後の巡回が消えない)。
      if (resumedRef.current === target.id) {
        await touchSession(target);
        if (!mountedRef.current) return;
      }
      if (mutationAbortRef.current) mutationAbortRef.current.abort();
      const ac = new AbortController();
      mutationAbortRef.current = ac;
      try {
        const res = await fetch(
          `/api/field-survey/sessions/${encodeURIComponent(target.id)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "ended" }),
            signal: ac.signal,
          },
        );
        if (!mountedRef.current) return;
        const body = (await res.json().catch(() => null)) as
          | { data?: ActiveSessionLike }
          | null;
        if (!mountedRef.current) return;
        const outcome = classifyTripApiResponse(
          res.status,
          extractApiErrorCode(body),
        );
        if (outcome.kind === "ok") {
          if (resumedRef.current === target.id) resumedRef.current = null;
          setSession(null);
          setPhase("idle");
          return;
        }
        if (outcome.kind === "conflict_state") {
          setError(tripOutcomeMessage(outcome));
          await fetchActiveSession();
          return;
        }
        setError(tripOutcomeMessage(outcome));
        // active state に復帰して再試行可能にする
        setPhase("active");
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) return;
        setError("巡回終了に失敗しました。");
        setPhase("active");
      }
    },
    [fetchActiveSession, onBeforeSessionEnd, touchSession],
  );

  if (phase === "loading") {
    return (
      <Panel>
        <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">巡回操作</div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400">状態を取得中…</p>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">巡回操作</div>

      {session ? (
        <ActiveSessionView
          session={session}
          now={now}
          onEnd={() => setPhase("confirmEnd")}
          disabled={phase === "ending"}
        />
      ) : (
        <IdleView
          onStart={() => setPhase("confirmStart")}
          disabled={phase === "starting"}
        />
      )}

      {error && (
        <p
          role="status"
          className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
        >
          {error}
        </p>
      )}

      {phase === "confirmStart" && (
        <ConfirmStartModal
          onCancel={() => setPhase("idle")}
          onAgree={() => void startSession()}
        />
      )}

      {phase === "confirmEnd" && session && (
        <ConfirmEndModal
          onCancel={() => setPhase("active")}
          onAgree={() => void endSession(session)}
        />
      )}

      {phase === "confirmStaleEnd" && session && (
        <ConfirmStaleEndModal
          session={session}
          now={now}
          onContinue={() => {
            resumedRef.current = session.id;
            setPhase("active");
            void touchSession(session);
          }}
          onAgree={() => void endSession(session)}
        />
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-gray-200 dark:border-gray-800 pt-2">{children}</div>;
}

function IdleView({
  onStart,
  disabled,
}: {
  onStart: () => void;
  disabled: boolean;
}) {
  return (
    <>
      <p className="mb-2 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
        巡回未開始
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        className="mb-1 w-full rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/40 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30"
        data-testid="trip-start-button"
      >
        巡回開始
      </button>
      <p className="text-[10px] leading-tight text-gray-400 dark:text-gray-500">
        ※ 位置情報の記録は別途「位置記録開始」を押した時のみ行われます。
        巡回開始だけでは GPS は使われません。
      </p>
    </>
  );
}

function ActiveSessionView({
  session,
  now,
  onEnd,
  disabled,
}: {
  session: ActiveSessionLike;
  now: Date;
  onEnd: () => void;
  disabled: boolean;
}) {
  const startedAt = new Date(session.startedAt);
  const elapsed = formatElapsed(startedAt, now);
  return (
    <>
      <p className="mb-1 text-[11px] leading-snug text-red-600 dark:text-red-400">
        ● 巡回中
      </p>
      <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700 dark:text-gray-200">
        <dt>経過</dt>
        <dd>{elapsed}</dd>
        <dt>取得点数</dt>
        <dd>{session.pointCount}</dd>
      </dl>
      <button
        type="button"
        onClick={onEnd}
        disabled={disabled}
        className="w-full rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/40 dark:bg-red-500/20 dark:text-red-300 dark:hover:bg-red-500/30"
        data-testid="trip-end-button"
      >
        巡回終了
      </button>
      <p className="mt-1 text-[10px] leading-tight text-gray-400 dark:text-gray-500">
        ※ 巡回終了時に位置記録は自動停止します。未送信点は失われる場合があります。
      </p>
    </>
  );
}

function ConfirmStartModal({
  onCancel,
  onAgree,
}: {
  onCancel: () => void;
  onAgree: () => void;
}) {
  return (
    <ModalShell title="🗺 巡回開始の確認" testId="trip-confirm-start-modal">
      <ul className="mb-3 ml-4 list-disc space-y-1 text-[11px] text-gray-700 dark:text-gray-200">
        <li>
          本機能は「巡回開始」を押してから「巡回終了」を押すまでの間のみ、
          業務上の位置情報を扱う前提です。
        </li>
        <li>常時監視ではありません。</li>
        <li>
          ブラウザを閉じても session が active のまま残る場合があります。
          再ログイン時に「巡回終了」を押してください。
        </li>
        <li>
          位置情報の記録は、別途「位置記録開始」を押した時のみ開始されます。
          巡回開始だけでは GPS は使われません。
        </li>
      </ul>
      <ModalActions
        onCancel={onCancel}
        onAgree={onAgree}
        agreeLabel="同意して開始"
      />
    </ModalShell>
  );
}

function ConfirmEndModal({
  onCancel,
  onAgree,
}: {
  onCancel: () => void;
  onAgree: () => void;
}) {
  return (
    <ModalShell title="巡回終了の確認" testId="trip-confirm-end-modal">
      <p className="mb-3 text-[12px] text-gray-700 dark:text-gray-200">
        巡回を終了します。よろしいですか?
      </p>
      <ModalActions onCancel={onCancel} onAgree={onAgree} agreeLabel="終了する" />
    </ModalShell>
  );
}

// B-7: 終了し忘れの放置 session を復元したときの終了確認。
// 「巡回を続ける」で従来どおりの巡回中表示に戻る (終了は既存 endSession を流用)。
function ConfirmStaleEndModal({
  session,
  now,
  onContinue,
  onAgree,
}: {
  session: ActiveSessionLike;
  now: Date;
  onContinue: () => void;
  onAgree: () => void;
}) {
  return (
    <ModalShell
      title="前回の巡回が終了されていません"
      testId="trip-confirm-stale-end-modal"
    >
      <p className="mb-3 text-[12px] text-gray-700 dark:text-gray-200">
        {formatStaleDuration(session.startedAt, now)}
        前に開始した巡回が、終了されないまま残っています。 巡回を終了しますか?
      </p>
      <ModalActions
        onCancel={onContinue}
        cancelLabel="巡回を続ける"
        onAgree={onAgree}
        agreeLabel="終了する"
      />
    </ModalShell>
  );
}

function ModalShell({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-white p-4 text-sm shadow-lg dark:bg-gray-900">
        <h3 className="mb-2 text-base font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ModalActions({
  onCancel,
  onAgree,
  agreeLabel,
  cancelLabel = "キャンセル",
}: {
  onCancel: () => void;
  onAgree: () => void;
  agreeLabel: string;
  cancelLabel?: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        onClick={onAgree}
        className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
      >
        {agreeLabel}
      </button>
    </div>
  );
}
