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

/**
 * 巡回終了時の flush 待ちのタイムアウト (@codex P2)。track-points API が停止/
 * ハングして応答しない場合、await onBeforeSessionEnd() が settle せず phase が
 * "ending" のまま固まり「破棄して終了」の脱出口へ到達できない。一定時間で
 * 打ち切って「終了ブロック」表示に倒し、脱出口を必ず出せるようにする。圏内の
 * 大 buffer flush を誤って打ち切らないよう余裕を持たせる (点は chunk 単位で
 * 送信済みが保全され、再度「巡回終了」を押せば残りから続行できる)。
 */
const END_FLUSH_SETTLE_TIMEOUT_MS = 15000;

/**
 * 巡回終了 PATCH のタイムアウト (@codex P2)。session 終了 API 自体が無応答の
 * 環境でも、押下後に phase が "ending" のまま固まって UI が無効化されないよう、
 * 一定時間で abort して active へ戻し再試行可能にする。破棄経路では buffer を
 * 保全したまま脱出口を再度提示する。
 */
const END_PATCH_TIMEOUT_MS = 15000;

/**
 * active session 整合 (reconcile) GET のタイムアウト (@codex P1)。曖昧な終了結果
 * を真の状態に整合する GET 自体が blackhole (応答も reject もしない) だと、終了
 * 脱出口が再び固まる。一定時間で打ち切り「不明」として扱う。
 */
const RECONCILE_TIMEOUT_MS = 12000;

/**
 * active session 整合の結果 (@codex P1)。
 * - active:  自分の active session が確実に存在する
 * - ended:   確実に active session が無い (= 終了済み)
 * - unknown: 整合に失敗/タイムアウトで判定不能 (session/buffer は保持し、
 *            整合が成功するまで active 操作をブロックする)
 */
type ReconcileResult =
  | { kind: "active"; session: ActiveSessionLike }
  | { kind: "ended" }
  | { kind: "unknown" };

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
  /**
   * 地図上の「巡回を開始」ボタン (パネル外) からの開始要求を受けるための
   * ハンドラ登録。effect で登録/解除し、呼ばれたら idle 時のみ確認 modal を
   * 開く (event 駆動。effect 内 setState を避ける)。
   */
  registerStartRequest?: (fn: (() => void) | null) => void;
  /**
   * 「未送信の位置記録を破棄して終了」の破棄側 (親の recorder が実装)。
   * 圏外などで flush できず巡回終了がブロックされた時の脱出口。
   */
  onDiscardUnsentLocations?: () => void;
  /**
   * 進行中の flush を即座に中断する (buffer は保持・親の recorder が実装)。
   * 「破棄して終了」で終了 PATCH を打つ前に呼び、timeout race に負けて裏で
   * 走り続けている drain が破棄予定の点を送るのを防ぐ (@codex P2)。
   */
  onAbortPendingFlush?: () => void;
  /**
   * 破棄経路で終了 PATCH が失敗した時に recorder を操作可能 (idle) へ戻す
   * (buffer 保持・親の recorder が実装)。PATCH 中は "stopping" 固着のままにして
   * 新 watch 開始を防ぎ、終了が成立しなかった時だけ復帰させる (@codex P2)。
   */
  onEndFailedRestoreRecorder?: () => void;
  /**
   * 終了処理が「曖昧」な間、recorder を "stopping" にして新 watch を開始させない
   * (buffer 保持・親の recorder が実装)。通常終了では flush 成功で idle になって
   * いるため、PATCH commit 済み + 応答喪失 + reconcile unknown のとき active に
   * 戻すと記録を再開でき 409 で失われる。それを防ぐ (@codex P1)。
   */
  onBlockRecorderForEnd?: () => void;
  /**
   * 未送信 buffer の点数 (recorder.bufferedCount)。「破棄して終了」で失われる
   * 軌跡の規模を平易に示すために表示する (圏外が長いと数百点になり得る)。
   */
  unsentLocationCount?: number;
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
  registerStartRequest,
  onDiscardUnsentLocations,
  onAbortPendingFlush,
  onEndFailedRestoreRecorder,
  onBlockRecorderForEnd,
  unsentLocationCount,
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
  // 圏外などで未送信 buffer が残り巡回終了がブロックされた状態。
  // 「破棄して終了」の脱出口ボタンを出すために保持する。
  const [endBlockedByBuffer, setEndBlockedByBuffer] = useState(false);

  // 地図上の「巡回を開始」ボタン用: 開始確認 modal を開くハンドラを親に登録する。
  // まだ session 取得中 (phase="loading") に押された場合は取得完了まで予約し、
  // idle に確定した時点で確認 modal を開く (取得中の空打ちで無反応になるのを防ぐ)。
  const pendingStartRef = useRef(false);
  const requestStart = useCallback(() => {
    setPhase((p) => {
      if (p === "idle") return "confirmStart";
      // loading 中は予約だけして、fetchActiveSession の解決時に開く。
      if (p === "loading") pendingStartRef.current = true;
      return p;
    });
  }, []);
  useEffect(() => {
    registerStartRequest?.(requestStart);
    return () => {
      registerStartRequest?.(null);
    };
  }, [registerStartRequest, requestStart]);

  const isAbortError = (err: unknown): boolean =>
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError";

  // active session 整合。@codex P1: 終了 PATCH の timeout / server error など
  // 曖昧な結果を、真の server 状態に整合させて呼び出し側が「まだ active / 終了済
  // / 判定不能」を区別できるよう ReconcileResult を返す。
  // - opts.timeoutMs: GET 自体の blackhole 対策 (打ち切りで unknown)。
  // - opts.preserveOnFailure: 失敗 (非 ok / network / timeout) で session / phase
  //   を消さず現状維持し unknown を返す (終了整合中に buffer を失わないため)。
  const fetchActiveSession = useCallback(
    async (opts?: {
      timeoutMs?: number;
      preserveOnFailure?: boolean;
    }): Promise<ReconcileResult> => {
      if (activeFetchAbortRef.current) activeFetchAbortRef.current.abort();
      const ac = new AbortController();
      activeFetchAbortRef.current = ac;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs) {
        timer = setTimeout(() => ac.abort(), opts.timeoutMs);
      }
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
        if (!mountedRef.current) return { kind: "unknown" };
        const body = (await res.json().catch(() => null)) as
          | { data?: ActiveSessionLike[] }
          | null;
        if (!mountedRef.current) return { kind: "unknown" };
        const outcome = classifyTripApiResponse(
          res.status,
          extractApiErrorCode(body),
        );
        if (outcome.kind !== "ok") {
          // server error 等は状態不明。preserveOnFailure なら session / phase を
          // 消さず現状維持して unknown を返す (終了整合中に buffer を失わない)。
          if (opts?.preserveOnFailure) {
            setError(tripOutcomeMessage(outcome));
            return { kind: "unknown" };
          }
          pendingStartRef.current = false;
          setError(tripOutcomeMessage(outcome));
          setSession(null);
          setPhase("idle");
          return { kind: "unknown" };
        }
        // pickOwnActiveSession は server filter 漏れに対する防御として残す。
        const own = pickOwnActiveSession(body?.data ?? [], currentUserId);
        setSession(own);
        // @codex P2: 既存 active session が復元された場合は、loading 中に予約された
        // 「巡回を開始」を破棄する。放置しておくと、後で別クライアントが終了して
        // active 無しに転じた refresh (conflict 後の再取得等) が古い予約を消化し、
        // 再調整/終了中に予期せず開始確認 modal を開いてしまう。
        if (own) pendingStartRef.current = false;
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
        } else if (own) {
          setPhase("active");
        } else if (pendingStartRef.current) {
          // loading 中に地図の「巡回を開始」が押されていた → 取得完了 (active
          // session 無し) で開始確認 modal を開く (空打ちを取りこぼさない)。
          pendingStartRef.current = false;
          setPhase("confirmStart");
        } else {
          setPhase("idle");
        }
        setError(null);
        return own ? { kind: "active", session: own } : { kind: "ended" };
      } catch (err) {
        // abort (timeout / supersede / unmount) は判定不能。session は消さない。
        if (isAbortError(err) || !mountedRef.current) return { kind: "unknown" };
        // network error。preserveOnFailure なら現状維持で unknown。
        if (opts?.preserveOnFailure) {
          setError("巡回情報の取得に失敗しました。");
          return { kind: "unknown" };
        }
        pendingStartRef.current = false;
        setError("巡回情報の取得に失敗しました。");
        setSession(null);
        setPhase("idle");
        return { kind: "unknown" };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    [currentUserId],
  );

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
    async (
      target: ActiveSessionLike,
      opts?: { discardUnsent?: boolean },
    ) => {
      setPhase("ending");
      setError(null);
      setEndBlockedByBuffer(false);
      // @codex P2: 「破棄して終了」経路では、まず進行中の flush を即座に中断する
      // (buffer は保持)。flush timeout race に負けて裏で走り続けている drain が
      // 遅れて応答し、破棄すると決めた点を送信/buffer から除去するのを防ぐ。
      // 実際の buffer 破棄は PATCH 成功後 (下記 onDiscardUnsentLocations)。
      if (opts?.discardUnsent) {
        onAbortPendingFlush?.();
      }
      // Phase 1-F-2: session PATCH の前に位置記録 (watchPosition / flush
      // timer / 残 buffer chunk flush) を停止する。throw は握り潰す。
      // Codex P1: 戻り値が明示的に false の場合 = 未送信 buffer が残っている。
      // session end PATCH を呼ばず active 状態へ戻し、ユーザーに再送信を促す。
      //
      // @codex P2: 「破棄して終了」(discardUnsent) のときは flush hook を呼ばない。
      // hook は未送信 track-point の再送 (fetch) を試みるため、endpoint が停止/
      // ハングしていると、点を破棄すると決めたユーザーの脱出口自体がまた固まる。
      // discardUnsent 経路に来る時点で、直前の通常終了 (endBlockedByBuffer を
      // 立てた側) が既に watchPosition を停止済みなので、ここで stop を省いても
      // watch は残らない。破棄は PATCH 成功後に行う (下記・offline 失敗時は
      // buffer を保全し、電波復帰後の通常終了で送信できるようにする)。
      if (onBeforeSessionEnd && !opts?.discardUnsent) {
        let beforeOk: boolean | void = undefined;
        // @codex P2: flush が settle しない (endpoint 停止/ハング) 場合でも脱出口
        // へ到達できるよう、一定時間で打ち切って「終了ブロック」に倒す。timeout が
        // 勝った場合は timedOut=true にして文言を切り替える。
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          beforeOk = await Promise.race([
            Promise.resolve(onBeforeSessionEnd()),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve(false);
              }, END_FLUSH_SETTLE_TIMEOUT_MS);
            }),
          ]);
        } catch {
          // 終了前 stop の失敗で巡回終了を阻まない (従来挙動)
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!mountedRef.current) return;
        if (beforeOk === false) {
          setError(
            timedOut
              ? "位置情報の送信が完了しません。電波の良い場所へ移動して、もう一度「巡回終了」を押すか、下の「破棄して終了」で終了できます。"
              : "未送信の位置情報が残っていて送信できません。電波の良い場所で、もう一度「巡回終了」を押すと再送信します。",
          );
          // 圏外/応答なしのまま終業する日の脱出口 (「破棄して終了」) を出す
          setEndBlockedByBuffer(true);
          setPhase("active");
          return;
        }
      }
      // B-7 (@codex R10): 続行済み session の終了は、直前に活動 touch を挟んで
      // server の stale 判定を解除する (続行時の touch が失敗していても、ここで
      // 記録されれば endedAt は now になり、続行後の巡回が消えない)。
      //
      // @codex P2 R4: ただし「破棄して終了」(discardUnsent) 経路では touch を
      // 省略する。touchSession は signal / timeout を持たず、脱出口を使うのは
      // 圏外/セッション API 障害の状況なので、ここで await すると touch が応答
      // しない時に phase が "ending" に固まり、追加した脱出口でも終了 PATCH に
      // 到達できなくなる。touch は best-effort であり、pin / 写真は既に保存済み
      // (session の endedAt メタデータのみ影響) なので破棄経路では省いてよい。
      if (resumedRef.current === target.id && !opts?.discardUnsent) {
        await touchSession(target);
        if (!mountedRef.current) return;
      }
      // @codex P1: PATCH 開始から結果が確定 (成功 / active reconcile) するまで、
      // recorder を "stopping" (非 startable) にして新 watch を開始させない。通常
      // 終了では flush 成功で idle になっているため、これが無いと PATCH commit 済み
      // + 応答喪失 + reconcile unknown のとき active に戻した瞬間に記録を再開でき、
      // 終了済み session への記録が 409 で失われる。破棄経路は abortInFlightFlush
      // で既に stopping だが冪等。buffer は保持する。
      onBlockRecorderForEnd?.();
      if (mutationAbortRef.current) mutationAbortRef.current.abort();
      const ac = new AbortController();
      mutationAbortRef.current = ac;
      // @codex P2: 終了 API 自体が無応答の環境でも脱出口が機能するよう、PATCH
      // にも timeout を設ける。timeout で abort した場合は active に戻して再試行
      // 可能にする (unmount / supersede の abort とは patchTimedOut で区別する)。
      let patchTimedOut = false;
      const patchTimer = setTimeout(() => {
        patchTimedOut = true;
        ac.abort();
      }, END_PATCH_TIMEOUT_MS);
      // @codex P1: 200 OK 以外 (5xx / conflict / timeout / network) は「server が
      // 終了を commit したか不明」= 曖昧。5xx は status 更新後の後続処理で throw
      // して 500 になる例、timeout は応答遅延、network は送信済み応答喪失の
      // いずれも server 側は終了済みの可能性がある。UI を active に決め打ちせず、
      // 下で reconcile して真の状態に整合してから active 操作を許可する。
      const failMessage = () =>
        patchTimedOut
          ? "巡回終了の通信が完了しません。電波の良い場所へ移動して、もう一度お試しください。"
          : "巡回終了に失敗しました。電波の良い場所で、もう一度お試しください。";
      let ambiguous = false;
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
          // 終了が確定してから未送信 buffer を破棄する (offline で PATCH が
          // 失敗した場合は破棄されず、軌跡が保全される)。
          if (opts?.discardUnsent) onDiscardUnsentLocations?.();
          if (resumedRef.current === target.id) resumedRef.current = null;
          setSession(null);
          setPhase("idle");
          return;
        }
        // 非 ok (conflict / 5xx / その他) は曖昧 → 下で reconcile。
        setError(tripOutcomeMessage(outcome));
        ambiguous = true;
      } catch (err) {
        if (!mountedRef.current) return;
        // unmount / supersede の abort (timeout ではない) は state を触らない。
        if (isAbortError(err) && !patchTimedOut) return;
        setError(failMessage());
        ambiguous = true;
      } finally {
        clearTimeout(patchTimer);
      }
      if (!ambiguous || !mountedRef.current) return;
      // 曖昧な結果を真の状態へ整合する。reconcile GET 自体も timeout し、失敗時は
      // session / buffer を消さず unknown とする (終了整合中に軌跡を失わない)。
      const reconciled = await fetchActiveSession({
        timeoutMs: RECONCILE_TIMEOUT_MS,
        preserveOnFailure: true,
      });
      if (!mountedRef.current) return;
      if (reconciled.kind === "active") {
        // まだ active。ambiguous の間 "stopping" にした recorder を操作可能 (idle)
        // へ戻す (両経路・buffer 保持)。破棄経路では脱出口も再提示する。
        setError(failMessage());
        onEndFailedRestoreRecorder?.();
        if (opts?.discardUnsent) setEndBlockedByBuffer(true);
      } else if (reconciled.kind === "unknown") {
        // 整合も判定不能。session / buffer は消さず active に戻して retry 可能に
        // する。recorder は stopping のまま = 状態不明の間は新 watch を開始させ
        // ない (整合が成功するまで active 操作をブロック)。
        setError(
          "巡回終了を確認できませんでした。電波の良い場所へ移動して、もう一度お試しください。",
        );
        setPhase("active");
        if (opts?.discardUnsent) setEndBlockedByBuffer(true);
      }
      // reconciled.kind === "ended" → fetchActiveSession が session null / idle
      // 済み。recorder は sessionId 変化の reset effect が片付ける (= 終了成功)。
    },
    [
      fetchActiveSession,
      onAbortPendingFlush,
      onBeforeSessionEnd,
      onBlockRecorderForEnd,
      onDiscardUnsentLocations,
      onEndFailedRestoreRecorder,
      touchSession,
    ],
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

      {endBlockedByBuffer && phase === "active" && session && (
        <div className="mt-2">
          {/* 圏外で終業する日の脱出口: 未送信の軌跡を諦めて終了する。破棄は
              endSession 内で PATCH 成功後に行う (offline で終了自体が失敗する
              場合は破棄されず軌跡を保全する)。 */}
          <button
            type="button"
            data-testid="trip-discard-and-end"
            onClick={() => {
              setEndBlockedByBuffer(false);
              void endSession(session, { discardUnsent: true });
            }}
            disabled={phase !== "active"}
            className="w-full rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
          >
            未送信の位置記録を破棄して終了する
          </button>
          <p className="mt-1 text-[11px] font-medium leading-tight text-gray-600 dark:text-gray-300">
            まだ送信できていない移動の記録
            {typeof unsentLocationCount === "number" && unsentLocationCount > 0
              ? ` (約${unsentLocationCount}点)`
              : ""}
            は失われます。ピンと写真は保存済みです。
          </p>
        </div>
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
