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
 * 本ファイルで扱わないもの:
 *   - navigator.geolocation 利用 (一切呼ばない)
 *   - TrackPoint 送信 / route polyline / 現在位置 marker
 *   - Wake Lock / IndexedDB / sessionStorage
 *
 * 端末保存について (2026-07-29):
 *   同意文を初回だけ出すため、**「同意文を出したか」の印だけ**を端末に置く
 *   (`field-survey-location-consent.ts`)。置くのは固定文字の印ひとつで、
 *   session id・座標・氏名は一切含めない。本ファイルは localStorage を直接
 *   触らず、その module 経由でのみ読み書きする。
 *
 * privacy:
 *   - API response を console に出さない
 *   - session detail / PII / lat/lng / API key / env 値を console に出さない
 *   - error message に server 内部 message を流出させない (汎用文言に変換)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LocationConsentNotice } from "@/components/field-survey/location-consent-notice";
import {
  hasLocationConsent,
  markLocationConsent,
} from "@/lib/field-survey-location-consent";
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
 * 続行済み stale session の終了直前 best-effort touch のタイムアウト (@codex P1)。
 * signal / timeout が無いと、touch PATCH が blackhole した時に通常終了が永久待機
 * し、phase="ending" 固着で終了 PATCH / reconcile / 脱出口へ到達できなくなる。
 * best-effort ゆえ一定時間で諦めて先へ進む。
 */
const TOUCH_TIMEOUT_MS = 8000;

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
  onActiveSessionChange?: (
    session: ActiveSessionLike | null,
    opts?: {
      /**
       * ⚠**この通知が「今この操作で始まった巡回」か**。再読込や画面復帰で
       * 既存の巡回を復元しただけの時は false。
       *
       * 親はこれを見て位置記録を自動開始する。区別しないと、休憩中に自分で
       * 「位置記録停止」を押した人が、アプリを開き直しただけで記録を再開
       * されてしまう (本人の意思に反して休憩場所が残る)。
       */
      justStarted?: boolean;
    },
  ) => void;
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
   * 地図上の「巡回終了」ボタン用 (第2弾 C3・registerStartRequest と対称)。
   * 終了は1日1回必ず行う操作なのに、パネルを開いて最下部まで
   * スクロールしないと届かなかった。確認モーダルは portal 済みなので
   * パネルが閉じていても必ず見える。
   */
  registerEndRequest?: (fn: (() => void) | null) => void;
  /**
   * #317: 巡回状態の再取得要求を受けるためのハンドラ登録 (registerStartRequest
   * と同型)。recorder の開始フェンス touch が 409/404 で「巡回は既に終了して
   * いる」と検知した時に親経由で呼ばれ、巡回中表示を真の状態へ整合させる。
   */
  registerSessionRefresh?: (fn: (() => void) | null) => void;
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
  registerEndRequest,
  registerSessionRefresh,
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
  // @codex P1 R15: 終了 PATCH が timeout/network/5xx で server 上に残り commit し
  // 得る状態。再試行を跨いで保持する (local 変数だと retry で false 初期化され、
  // 遅延 commit がまだ可能なのに recorder を復帰させてしまう)。session 単位で、
  // 確実な終了 (200 OK / reconcile ended) か新規 session 開始まで true を保つ。
  // true の間は active reconcile でも recorder を復帰させない。
  const outstandingEndMayCommitRef = useRef(false);
  // 圏外などで未送信 buffer が残り巡回終了がブロックされた状態。
  // 「破棄して終了」の脱出口ボタンを出すために保持する。
  const [endBlockedByBuffer, setEndBlockedByBuffer] = useState(false);

  // 地図上の「巡回を開始」ボタン用: 開始確認 modal を開くハンドラを親に登録する。
  // まだ session 取得中 (phase="loading") に押された場合は取得完了まで予約し、
  // idle に確定した時点で確認 modal を開く (取得中の空打ちで無反応になるのを防ぐ)。
  const pendingStartRef = useRef(false);
  // 「今この操作で始まった巡回」の id。復元 (再読込・画面復帰) と区別するため。
  const justStartedIdRef = useRef<string | null>(null);
  // 同意文は初回だけ出す (2026-07-29 業務判断)。端末に印が無いときだけ、
  // 開始確認に位置記録の説明を載せる。印は端末ローカルにしか持たない。
  const [needsLocationConsent, setNeedsLocationConsent] = useState(false);
  const refreshConsentNeed = useCallback(() => {
    setNeedsLocationConsent(!hasLocationConsent());
  }, []);
  const requestStart = useCallback(() => {
    refreshConsentNeed();
    setPhase((p) => {
      if (p === "idle") return "confirmStart";
      // loading 中は予約だけして、fetchActiveSession の解決時に開く。
      if (p === "loading") pendingStartRef.current = true;
      return p;
    });
  }, [refreshConsentNeed]);
  useEffect(() => {
    registerStartRequest?.(requestStart);
    return () => {
      registerStartRequest?.(null);
    };
  }, [registerStartRequest, requestStart]);
  const requestEnd = useCallback(() => {
    // active のときだけ確認モーダルへ(loading/ending 中の連打は無視)。
    setPhase((p) => (p === "active" ? "confirmEnd" : p));
  }, []);
  useEffect(() => {
    registerEndRequest?.(requestEnd);
    return () => {
      registerEndRequest?.(null);
    };
  }, [registerEndRequest, requestEnd]);

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
          refreshConsentNeed();
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
    [currentUserId, refreshConsentNeed],
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

  // #317: recorder の開始フェンスが「巡回は既に終了」を検知した時の再取得要求を
  // 親に登録する (registerStartRequest と同型・event 駆動)。GET は timeout 付き。
  // フェンスが 409 を返した時点で終了は確定しているため、失敗時に session を
  // 消す既定挙動 (preserveOnFailure なし) で問題ない。
  const requestRefresh = useCallback(() => {
    void fetchActiveSession({ timeoutMs: RECONCILE_TIMEOUT_MS });
  }, [fetchActiveSession]);
  useEffect(() => {
    registerSessionRefresh?.(requestRefresh);
    return () => {
      registerSessionRefresh?.(null);
    };
  }, [registerSessionRefresh, requestRefresh]);

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
    const justStarted = !!session && justStartedIdRef.current === session.id;
    // 一度伝えたら降ろす (同じ session の再通知で二度立てない)。
    if (justStarted) justStartedIdRef.current = null;
    onActiveSessionChange(session, { justStarted });
  }, [session, onActiveSessionChange]);

  const startSession = useCallback(async () => {
    setPhase("starting");
    setError(null);
    // @codex P1 R15: 新規 session を開始する前に、前 session の「commit し得る
    // 終了」flag を解除する (別 session に持ち越さない)。
    outstandingEndMayCommitRef.current = false;
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
        justStartedIdRef.current = body.data.id;
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
  //
  // #317 (@codex R3): 終了直前の touch はフェンストークンの発行も兼ねる。
  // 応答の session.updatedAt (= この touch が永続化した世代値) を返し、終了
  // PATCH に echo する。conflict=true は並行終了済み (reconcile 実施済み)。
  // #317 (@codex R7): この touch は世代 (activitySeq) を進めない通常の活動記録
  // (fence: true を送らない)。終了フロー内の R10 バックストップとして呼んでも
  // 「終了意図の時点でピンした世代」を自分で壊さない。
  const touchSession = useCallback(
    async (target: ActiveSessionLike): Promise<void> => {
      // @codex P1: best-effort touch に timeout を付ける。blackhole すると通常
      // 終了がここで永久待機し phase="ending" 固着で終了 PATCH / reconcile /
      // 脱出口へ到達できない。timeout 後は touch を諦めて先へ進む。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TOUCH_TIMEOUT_MS);
      try {
        const res = await fetch(
          `/api/field-survey/sessions/${encodeURIComponent(target.id)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ touch: true }),
            signal: ac.signal,
          },
        );
        if (!mountedRef.current) return;
        if (res.status === 409) {
          // 並行で終了済み (@codex R9)。終了済み session を巡回中として使い
          // 続けないよう、状態を取り直して UI を整合させる (GET も timeout 付き)。
          await fetchActiveSession({ timeoutMs: RECONCILE_TIMEOUT_MS });
        }
      } catch {
        // best effort (オフライン / timeout 等)。続行操作はローカルで成立させる。
      } finally {
        clearTimeout(timer);
      }
    },
    [fetchActiveSession],
  );

  // #317 (@codex R5): 終了フローの「操作開始時点で既知の世代」を取る読み取り
  // 専用 GET。fetchActiveSession と違い UI state を一切触らない (phase="ending"
  // 中に session/phase を書き換えない)。drain 完了後に呼ぶため、自分の flush
  // による世代前進もここで取り込める (client 側で世代を別途追跡する配線が
  // 不要になる)。読み取りは何も鋳造しないため、遅延・陳腐化しても後段の
  // CAS touch が必ず検出する (古い世代での CAS は 0 行 → 409)。
  const fetchOwnActiveGeneration = useCallback(
    async (
      targetId: string,
    ): Promise<
      | { kind: "active"; activitySeq: number | null }
      | { kind: "ended" }
      | { kind: "unknown" }
    > => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RECONCILE_TIMEOUT_MS);
      try {
        const url =
          `/api/field-survey/sessions?status=active` +
          `&staffUserId=${encodeURIComponent(currentUserId)}&limit=1`;
        const res = await fetch(url, {
          signal: ac.signal,
          credentials: "same-origin",
        });
        if (!res.ok) return { kind: "unknown" };
        const body = (await res.json().catch(() => null)) as
          | { data?: ActiveSessionLike[] }
          | null;
        const own = pickOwnActiveSession(body?.data ?? [], currentUserId);
        if (!own || own.id !== targetId) return { kind: "ended" };
        const s = own.activitySeq;
        return {
          kind: "active",
          activitySeq:
            typeof s === "number" && Number.isInteger(s) ? s : null,
        };
      } catch {
        return { kind: "unknown" };
      } finally {
        clearTimeout(timer);
      }
    },
    [currentUserId],
  );

  const endSession = useCallback(
    async (
      target: ActiveSessionLike,
      opts?: {
        discardUnsent?: boolean;
        /**
         * B-7 の放置 session を確認 modal から直接終了する経路。フェンス
         * トークン発行の touch を打つと server の stale 判定が解除され
         * endedAt=now になってしまうため、touch を省略しトークン無しで送る
         * (server は到着時刻条件へフォールバック)。
         */
        staleDirect?: boolean;
      },
    ) => {
      setPhase("ending");
      setError(null);
      setEndBlockedByBuffer(false);
      // #317 (@codex R3〜R7) フェンストークン (世代カウンタ activitySeq) のピン。
      // 「終了の意図時点」= drain より前に読み取り GET でピンする (R7: drain は
      // 最大 15 秒あり、その間に別 client が記録を再開 (フェンス = 世代 +1) して
      // も、drain 後に読むとその新世代を吸収してしまう)。flush は世代を進めない
      // ため、自分の drain でピンは壊れない。以後この終了は「ピンした世代の
      // まま」の時のみ commit でき、意図より後のフェンスには (リクエストが
      // どの段階で遅延していても) 必ず負ける。読み取りは何も書かないため、
      // 遅延・陳腐化した GET は古いピンを返すだけ = 終了が 409 に倒れる安全側。
      // - staleDirect (放置 session の直接終了): 復元 GET で得た client 既知の
      //   世代をそのまま使う (touch しない = stale 判定と endedAt 規則を保全)。
      // - GET 不達 (完全圏外): 終了を送らず再試行を案内 — その状況では終了
      //   PATCH 自体も届かないため、従来挙動から失うものは無い。
      let fenceToken: number | null = null;
      if (opts?.staleDirect) {
        if (typeof target.activitySeq === "number") {
          fenceToken = target.activitySeq;
        }
      } else {
        const known = await fetchOwnActiveGeneration(target.id);
        if (!mountedRef.current) return;
        if (known.kind === "ended") {
          // ⚠**先に、貯まっている位置記録を送り切る** (@codex #356 P1)。
          //
          // 無操作1時間の自動終了が入ると、圏外で歩き続けた人は**必ずこの経路**に
          // 来る (戻って「巡回終了」を押した時点で、server 側は既に終了済み)。
          // ここで送らずに reconcile へ進むと、巡回が null になった時点で記録係が
          // 初期化され、**端末に貯めた記録がまるごと消える**。
          // server 側は自動終了した巡回に限って後からの受け取りを許しているので、
          // 送りさえすれば失われない。送れなかったときは reconcile せず、
          // 記録を残したまま再試行 / 「破棄して終了」へ倒す。
          if (onBeforeSessionEnd && !opts?.discardUnsent) {
            let drained: boolean | void = undefined;
            let drainTimedOut = false;
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              drained = await Promise.race([
                Promise.resolve(onBeforeSessionEnd()),
                new Promise<false>((resolve) => {
                  drainTimer = setTimeout(() => {
                    drainTimedOut = true;
                    resolve(false);
                  }, END_FLUSH_SETTLE_TIMEOUT_MS);
                }),
              ]);
            } catch {
              // 送信の失敗で終了操作を壊さない (下の false 分岐で案内する)。
            } finally {
              if (drainTimer) clearTimeout(drainTimer);
            }
            if (!mountedRef.current) return;
            if (drained === false) {
              setError(
                drainTimedOut
                  ? "位置情報の送信が完了しません。電波の良い場所へ移動して、もう一度「巡回終了」を押すか、下の「破棄して終了」で終了できます。"
                  : "未送信の位置情報が残っていて送信できません。電波の良い場所で、もう一度「巡回終了」を押すと再送信します。",
              );
              // 圏外のまま終業する日の脱出口 (「破棄して終了」) を出す。
              setEndBlockedByBuffer(true);
              setPhase("active");
              return;
            }
            // ⚠**送り切れたら「終わった」と伝える** (@codex #356 P2)。
            // 記録が届いた巡回は「まだ歩いているかも」として踏破マップから
            // 外れている。本人が終了を押したのだから、見回りの次の1時間を
            // 待たずに戻せる。ここで伝えないと、歩いた道が最大1時間以上
            // (見回りが遅れればさらに) 地図に出ない。
            // 失敗しても操作は止めない (見回りが後で必ず戻す)。
            try {
              await fetch(
                `/api/field-survey/sessions/${encodeURIComponent(target.id)}`,
                {
                  method: "PATCH",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: "ended" }),
                },
              );
            } catch {
              // 通信失敗は無視 (踏破マップへの復帰が遅れるだけ)。
            }
            if (!mountedRef.current) return;
          }
          // 既に active でない (並行終了済み等)。全体 reconcile で UI を整合
          // させ、この終了操作は完了扱いにする。reconcile 自体が timeout 等で
          // 判定不能 (unknown・state 未変更) の場合は phase="ending" のまま
          // 固まらないよう active に戻して再試行可能にする (@codex R6 P2)。
          const rec = await fetchActiveSession({
            timeoutMs: RECONCILE_TIMEOUT_MS,
          });
          if (!mountedRef.current) return;
          if (rec.kind === "unknown") {
            setError(
              "巡回終了を確認できませんでした。電波の良い場所へ移動して、もう一度お試しください。",
            );
            setPhase("active");
          }
          return;
        }
        if (known.kind === "active") {
          fenceToken = known.activitySeq;
        }
      }
      if (fenceToken === null) {
        // ピンを得られない間は終了を送らない (tokenless は server が拒否)。
        // まだ drain / recorder 停止の前なので、active に戻すだけで安全に
        // 再試行できる。
        setError(
          "巡回終了の通信ができませんでした。電波の良い場所で、もう一度お試しください。",
        );
        setPhase("active");
        if (opts?.discardUnsent) setEndBlockedByBuffer(true);
        return;
      }
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
      // @codex P1 R11/R13: ここから終了結果が確定 (成功 / active reconcile) する
      // まで recorder を "stopping" (非 startable) にして新 watch を開始させない。
      // 通常終了では直前の flush 成功で idle に戻っているため、これを touch await
      // (最大 8 秒) や PATCH の前に置かないと、その間に「位置記録開始」が露出して
      // 新 watch を開始でき、終了成功でその点が失われたり active reconcile 後に
      // watch が不可視で走り続けたりする。block は watch 停止 + in-flight 無効化も
      // 行う (snuck-in watch を残さない)。破棄経路は abortInFlightFlush で既に
      // stopping だが冪等。buffer は保持する。
      onBlockRecorderForEnd?.();
      // B-7 (@codex R10/R12): 続行済み session の終了は、直前に活動 touch
      // (fence 無し = 世代を進めない → 意図時点のピンを壊さない) を挟んで
      // server の stale 判定を解除する (続行時の touch が offline で失敗して
      // いても endedAt が続行前の時刻へ巻き戻らない)。破棄経路では touch が
      // ハングした時の脱出口固着を避けるため従来どおり省略する (P2 R4)。
      if (resumedRef.current === target.id && !opts?.discardUnsent) {
        await touchSession(target);
        if (!mountedRef.current) return;
      }
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
      // @codex P1 R14: outstanding な終了 PATCH が (client abort 後も) server 側で
      // commit し得るか。timeout / network (送信済みかも) / 5xx (更新後に throw
      // かも) は true。この場合、単発 reconcile が active でも recorder を解除しな
      // い (解除→記録再開中に遅延 PATCH が commit すると新規点が 409 で送れなく
      // なる)。commit し得ない (server が明確に未 commit=4xx 応答) 時のみ復帰する。
      // 完全な解消には server 側の冪等キー/operation-id 等の整合プロトコルが要る。
      let mutationMayHaveCommitted = false;
      try {
        const res = await fetch(
          `/api/field-survey/sessions/${encodeURIComponent(target.id)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "ended",
              // #317: フェンストークン (CAS touch 応答 / 復元 GET の activitySeq
              // echo)。終了は必ずこれを同封する (tokenless は server が拒否)。
              expectedActivitySeq: fenceToken,
            }),
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
          // 確実な終了 → outstanding 終了 flag を解除。
          outstandingEndMayCommitRef.current = false;
          setSession(null);
          setPhase("idle");
          return;
        }
        // 非 ok (conflict / 5xx / その他) は曖昧 → 下で reconcile。5xx は更新後に
        // throw して commit 済みの可能性があるため mayHaveCommitted。4xx は server
        // が明確に未 commit (拒否) なので false のまま。
        setError(tripOutcomeMessage(outcome));
        ambiguous = true;
        mutationMayHaveCommitted = res.status >= 500;
      } catch (err) {
        if (!mountedRef.current) return;
        // unmount / supersede の abort (timeout ではない) は state を触らない。
        if (isAbortError(err) && !patchTimedOut) return;
        // timeout / network は送信済みかもしれず commit し得る。
        setError(failMessage());
        ambiguous = true;
        mutationMayHaveCommitted = true;
      } finally {
        clearTimeout(patchTimer);
        // @codex P1 R15: 「commit し得る終了」を session 単位 ref に累積する
        // (再試行を跨いで保持)。確実な終了/新規 session まで解除しない。
        if (mutationMayHaveCommitted) outstandingEndMayCommitRef.current = true;
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
        // まだ active。破棄経路では脱出口を再提示する。
        setError(failMessage());
        if (opts?.discardUnsent) setEndBlockedByBuffer(true);
        // @codex P1 R14/R15: outstanding な終了 PATCH が commit し得ない時のみ
        // recorder を操作可能へ戻す。commit し得る (timeout / network / 5xx) 場合は
        // この単発 reconcile が active でも stopping のまま残す (遅延 commit と記録
        // 再開のレースで新規点が失われる)。判定は session 単位 ref で行い、再試行を
        // 跨いで保持する (前回の timeout の outstanding PATCH がまだ commit し得る
        // のに、今回の 4xx で false 初期化して復帰してしまうのを防ぐ)。ユーザーは
        // 終了を再試行して確定させる。
        if (!outstandingEndMayCommitRef.current) onEndFailedRestoreRecorder?.();
      } else if (reconciled.kind === "unknown") {
        // 整合も判定不能。session / buffer は消さず active に戻して retry 可能に
        // する。recorder は stopping のまま = 状態不明の間は新 watch を開始させ
        // ない (整合が成功するまで active 操作をブロック)。
        setError(
          "巡回終了を確認できませんでした。電波の良い場所へ移動して、もう一度お試しください。",
        );
        setPhase("active");
        if (opts?.discardUnsent) setEndBlockedByBuffer(true);
      } else {
        // reconciled.kind === "ended" → 確実に終了 (別クライアント / 遅延 commit
        // 含む)。outstanding flag を解除。fetchActiveSession が session null / idle
        // 済み。recorder は sessionId 変化の reset effect が片付ける (= 終了成功)。
        outstandingEndMayCommitRef.current = false;
      }
    },
    [
      fetchActiveSession,
      fetchOwnActiveGeneration,
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
          onStart={() => {
            refreshConsentNeed();
            setPhase("confirmStart");
          }}
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
          showLocationConsent={needsLocationConsent}
          onCancel={() => setPhase("idle")}
          onAgree={() => {
            // 印は「出した」ではなく「同意された」時にだけ残す。
            if (needsLocationConsent) markLocationConsent();
            void startSession();
          }}
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
          onAgree={() => void endSession(session, { staleDirect: true })}
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
        ※ 押すと位置の記録が始まり、地図が現在地へ移動します。
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
  showLocationConsent,
  onCancel,
  onAgree,
}: {
  /**
   * 位置記録の説明を載せるか。**その端末で初めて巡回を始めるときだけ true**。
   * 毎回出すと日々の業務で邪魔になるという業務判断 (2026-07-29)。
   */
  showLocationConsent: boolean;
  onCancel: () => void;
  onAgree: () => void;
}) {
  return (
    <ModalShell title="🗺 巡回開始の確認" testId="trip-confirm-start-modal">
      <ul className="mb-3 ml-4 list-disc space-y-1 text-[11px] text-gray-700 dark:text-gray-200">
        <li>巡回中は位置を記録します。常時監視ではありません。</li>
        <li>「巡回終了」を押すまでの間だけです。</li>
        <li>
          ブラウザを閉じても巡回が続いたままになることがあります。
          その場合は次に開いたときに「巡回終了」を押してください。
        </li>
      </ul>
      {showLocationConsent && (
        <div
          data-testid="trip-start-location-consent"
          className="mb-3 rounded border border-gray-300 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/40"
        >
          <p className="mb-1 text-[11px] font-semibold text-gray-800 dark:text-gray-100">
            📍 位置記録について (初回のみ)
          </p>
          <LocationConsentNotice />
        </div>
      )}
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
  // ⚠portal で body 直下に出す(地図操作性 第1弾 A2)。この部品はスマホでは
  //   閉じている(display:none)表示切替パネルの**子孫**として描画されるため、
  //   「前回の巡回が終了されていません」等の確認が画面に出ない事故があった。
  //   モーダルは親の開閉と無関係に必ず見えなければならない。
  return createPortal(
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
    </div>,
    document.body,
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
