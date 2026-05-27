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
  pickOwnActiveSession,
  tripOutcomeMessage,
  type ActiveSessionLike,
} from "@/lib/field-survey-trip-util";

interface TripControlsProps {
  currentUserId: string;
}

type Phase =
  | "loading" // 初期 active session 取得中
  | "idle" // 巡回未開始
  | "confirmStart" // 注意文言 modal 表示中
  | "starting" // POST sessions 中
  | "active" // 巡回中
  | "confirmEnd" // 終了確認 modal 表示中
  | "ending"; // PATCH sessions 中

export default function TripControls({ currentUserId }: TripControlsProps) {
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
      setPhase(own ? "active" : "idle");
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

  const endSession = useCallback(
    async (target: ActiveSessionLike) => {
      setPhase("ending");
      setError(null);
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
    [fetchActiveSession],
  );

  if (phase === "loading") {
    return (
      <Panel>
        <div className="mb-1 text-xs font-semibold text-gray-600">巡回操作</div>
        <p className="text-[11px] text-gray-500">状態を取得中…</p>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="mb-1 text-xs font-semibold text-gray-600">巡回操作</div>

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
          className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
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
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-gray-200 pt-2">{children}</div>;
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
      <p className="mb-2 text-[11px] leading-snug text-gray-500">
        巡回未開始
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        className="mb-1 w-full rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="trip-start-button"
      >
        巡回開始
      </button>
      <p className="text-[10px] leading-tight text-gray-400">
        ※ 現フェーズ (Phase 1-F-1) では位置情報の取得・記録は行いません。
        次フェーズで GPS 記録機能が追加されます。
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
      <p className="mb-1 text-[11px] leading-snug text-red-600">
        ● 巡回中
      </p>
      <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
        <dt>経過</dt>
        <dd>{elapsed}</dd>
        <dt>取得点数</dt>
        <dd>{session.pointCount}</dd>
      </dl>
      <button
        type="button"
        onClick={onEnd}
        disabled={disabled}
        className="w-full rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="trip-end-button"
      >
        巡回終了
      </button>
      <p className="mt-1 text-[10px] leading-tight text-gray-400">
        ※ 本フェーズではまだ位置情報を記録していません。
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
      <ul className="mb-3 ml-4 list-disc space-y-1 text-[11px] text-gray-700">
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
          現フェーズ (Phase 1-F-1) では位置情報の取得・記録・送信は
          まだ行いません。次フェーズで GPS 記録機能が追加される予定です。
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
      <p className="mb-3 text-[12px] text-gray-700">
        巡回を終了します。よろしいですか?
      </p>
      <ModalActions onCancel={onCancel} onAgree={onAgree} agreeLabel="終了する" />
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
      <div className="w-full max-w-md rounded-md bg-white p-4 text-sm shadow-lg">
        <h3 className="mb-2 text-base font-semibold text-gray-800">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ModalActions({
  onCancel,
  onAgree,
  agreeLabel,
}: {
  onCancel: () => void;
  onAgree: () => void;
  agreeLabel: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
      >
        キャンセル
      </button>
      <button
        type="button"
        onClick={onAgree}
        className="rounded border border-blue-600 bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
      >
        {agreeLabel}
      </button>
    </div>
  );
}
