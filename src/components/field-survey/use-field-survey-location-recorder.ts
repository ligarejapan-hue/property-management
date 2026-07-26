"use client";

/**
 * 現地調査マップ Phase 1-F-2: 位置記録 hook。
 *
 * - active session がある場合のみ navigator.geolocation.watchPosition を
 *   呼び、TrackPoint を memory buffer に貯めて batch POST する。
 * - active session 復元時は自動で位置記録を再開しない。
 *   ユーザーが「位置記録開始」を押した時のみ start() を実行する。
 * - localStorage / sessionStorage / IndexedDB は使わない。
 *   ブラウザを閉じた場合、未送信 buffer は失われる (UI 側で注意文言)。
 * - console.* に lat / lng / raw position / API response 全文を出さない。
 *
 * 外部依存:
 *  - navigator.geolocation (副作用は本 hook に閉じる)
 *  - fetch /api/field-survey/sessions/[id]/track-points (GET / POST)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FIELD_SURVEY_FETCH_PAGE_LIMIT,
  FIELD_SURVEY_FETCH_PAGE_MAX,
  FIELD_SURVEY_FLUSH_API_BATCH_LIMIT,
  FIELD_SURVEY_FLUSH_BATCH_SIZE,
  FIELD_SURVEY_FLUSH_INTERVAL_MS,
  describeGeolocationError,
  isLowAccuracy,
  maxSequenceFromBuffer,
  nextSequence,
  normalizePosition,
  shouldAcceptCandidate,
  shouldFlushNow,
  type TrackPointInput,
} from "@/lib/field-survey-geolocation-util";
import { classifyStartFence } from "@/lib/field-survey-trip-util";

export type RecorderStatus =
  | "idle" // 未記録 (active session があっても自動 start しない)
  | "preparing" // start 押下後の事前 fetch / watchPosition 開始処理中
  | "recording" // watchPosition 進行中
  | "stopping" // stop 押下後の clearWatch + 最終 flush 中
  | "error"; // 致命的エラー (permission denied / unavailable / timeout 等)

export interface RecorderPoint {
  sequence: number;
  lat: number;
  lng: number;
}

/**
 * Phase 1-F-3: 現在地表示 UI 用 snapshot。
 * TrackPoint 保存判定 (shouldAcceptCandidate / sequence / batch flush) とは独立し、
 * watchPosition の成功コールバックで都度更新される。
 * - lat / lng は marker / panTo 用にのみ使い、UI に数値表示しない。
 * - accuracy は表示用に round 表記 (helper 経由)。number | null。
 * - capturedAt は最終取得時刻表示用 (HH:MM:SS)。
 */
export interface LatestPositionForDisplay {
  lat: number;
  lng: number;
  accuracy: number | null;
  capturedAt: Date;
}

export interface UseLocationRecorderResult {
  status: RecorderStatus;
  /** start 後の累積。flush 成功で buffer から savedPoints に移動する。 */
  savedPoints: RecorderPoint[];
  /**
   * 未送信 (memory buffer) の点を polyline 表示に使うための snapshot。
   * sequence は savedPoints と重複しない (flush 成功で savedPoints に移ると同時に
   * この配列から消える)。lat/lng のみ保持 (accuracy / recordedAt は polyline 不要)。
   */
  pendingPoints: RecorderPoint[];
  /** 未送信 (memory buffer) の件数。値そのものは UI には数字としてのみ出す。 */
  bufferedCount: number;
  /** 直近 flush 成功時刻 (UI で「最終送信時刻」に使う)。null = 未送信。 */
  lastFlushAt: Date | null;
  /** 直近 flush 中フラグ (二重送信抑止用にも使われる)。 */
  isFlushing: boolean;
  /** 直近で受け取った accuracy が低精度判定だったか (lat/lng は保持しない)。 */
  isLowAccuracyNow: boolean;
  /**
   * Phase 1-F-3: 現在地表示 UI 用の最新位置 snapshot。
   * watchPosition 成功時 (採用/不採用に関わらず) に更新される。
   * 不正座標 / over-limit accuracy で normalizePosition が null を返した場合は更新しない。
   * lat / lng は marker / panTo に渡るが、UI に数値表示しない。
   */
  latestPositionForDisplay: LatestPositionForDisplay | null;
  /**
   * Phase 1-F-3: 位置「取得」失敗の表示用文言 (lat/lng/PII を含まない)。
   * 既存 error (送信失敗 / fetch 失敗等を含む) とは分離する。
   * handlePositionError でのみ set / 採用成功時に null に戻す。
   */
  lastLocationErrorForDisplay: string | null;
  /**
   * Phase 1-F-3: 「位置記録中だがまだ 1 度も位置を取得できていない」表示用フラグ。
   * (status === "preparing" || "recording") && latestPositionForDisplay === null。
   */
  isWaitingForFirstLocation: boolean;
  /** ユーザー向け汎用エラー文言 (lat/lng/PII を含まない)。 */
  error: string | null;
  /** 位置記録開始。すでに recording の場合は何もしない。 */
  start: () => void;
  /** 位置記録停止。可能なら残 buffer を flush してから idle に戻す。 */
  stop: () => Promise<void>;
  /**
   * 巡回終了直前の連動フック。watch を即時 clearWatch + timer 停止し、
   * その後 buffer が空になるまで chunk (= 200 件以下 / 回) で flush を試みる。
   * session API への PATCH 前に await されることを想定。
   *
   * 戻り値:
   *  - true: buffer 完全排出 (session end に進んで良い)
   *  - false: HTTP/network 等で送れず残 buffer あり (session end PATCH を
   *    呼ばないことで未送信データを保持し、次回再試行できる)
   */
  stopBeforeSessionEnd: () => Promise<boolean>;
  /**
   * 未送信の位置記録を破棄して即時停止する (圏外時の巡回終了の脱出口)。
   * flush を試みず buffer / in-flight を捨てる。地下駐車場・山間部など
   * 電波の無い場所で終業する日に「数点の軌跡を諦めて終了する」ための
   * 明示操作 (TripControls の「破棄して終了」) からのみ呼ぶ。
   */
  discardBufferAndStop: () => void;
  /**
   * 進行中の flush を即座に無効化・中断する (buffer は保持する)。
   * 「破棄して終了」で終了 PATCH を打つ前に、flush timeout race に負けて裏で
   * 走り続けている drain の遅延応答が、破棄予定の点を送信/除去するのを防ぐ。
   * buffer は残し、終了 PATCH 成功後に discardBufferAndStop で破棄する。
   */
  abortInFlightFlush: () => void;
  /**
   * 破棄経路で終了 PATCH が失敗した時、buffer を保持したまま recorder を操作可能
   * (idle) に戻す。abortInFlightFlush で "stopping" 固着にした状態を、終了が成立
   * しなかった場合にのみ復帰させる (PATCH 中に新 watch を開始させないため)。
   */
  restoreIdleAfterFailedEnd: () => void;
  /**
   * 終了処理が「曖昧」な間、recorder を "stopping" (非 startable) にして新 watch
   * の開始を防ぐ。両経路 (通常終了 / 破棄) の ambiguous な終了で使い、reconcile
   * が active を確認するまで解除しない。buffer は保持する。
   */
  blockRecorderForPendingEnd: () => void;
}

interface UseLocationRecorderOptions {
  /** 巡回 session ID。null の間は start しても何もしない。 */
  sessionId: string | null;
  /** 環境差吸収用 (vitest 等で navigator.geolocation を差し替える窓口)。 */
  geolocation?: Geolocation;
  /**
   * テスト用 fetch override (本番では未指定で window.fetch を使う)。
   * 返り値の Response 互換 ({ ok, status, json })。
   */
  fetcher?: typeof fetch;
  /**
   * #317: 位置記録開始のフェンス touch が 409/404 を返し「巡回は既に終了して
   * いる」と判明した時の通知。親は巡回状態の再取得で UI (巡回中表示) を整合
   * させる。座標や API 応答は渡さない。
   */
  onSessionEnded?: () => void;
}

/**
 * #317: 位置記録開始フェンス (活動 touch) のタイムアウト。blackhole しても
 * 開始判断が固まらないよう一定時間で打ち切る (成立を確認できなければ開始は
 * ブロックし再試行を促す = fail-closed)。
 */
const START_FENCE_TIMEOUT_MS = 8000;

interface ApiTrackPointRow {
  sequence: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  recordedAt: string;
}

const POST_HEADERS = { "Content-Type": "application/json" } as const;

export function useFieldSurveyLocationRecorder(
  options: UseLocationRecorderOptions,
): UseLocationRecorderResult {
  const { sessionId } = options;
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [savedPoints, setSavedPoints] = useState<RecorderPoint[]>([]);
  const [pendingPoints, setPendingPoints] = useState<RecorderPoint[]>([]);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [lastFlushAt, setLastFlushAt] = useState<Date | null>(null);
  const [isFlushing, setIsFlushing] = useState(false);
  const [isLowAccuracyNow, setIsLowAccuracyNow] = useState(false);
  // Phase 1-F-3: 現在地表示 UI 用 state。TrackPoint 採用判定とは独立。
  const [latestPositionForDisplay, setLatestPositionForDisplay] =
    useState<LatestPositionForDisplay | null>(null);
  const [lastLocationErrorForDisplay, setLastLocationErrorForDisplay] =
    useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // refs (state 更新が遅延する非同期周りで参照する)
  const bufferRef = useRef<TrackPointInput[]>([]);
  const lastAcceptedRef = useRef<{
    lat: number;
    lng: number;
    recordedAtMs: number;
  } | null>(null);
  const nextSequenceRef = useRef<number>(0);
  const watchIdRef = useRef<number | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightFlushRef = useRef<boolean>(false);
  // Codex P1 (fix 1): in-flight flush を Promise として追跡し、巡回終了時に
  // 「実 POST の完了」を await できるようにする。flushBuffer 入口で代入、
  // finally で null に戻す。
  const inFlightFlushPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastFlushAtMsRef = useRef<number | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const flushAbortRef = useRef<AbortController | null>(null);
  // #317: 進行中の開始フェンス touch。stop / block / discard / unmount で他の
  // in-flight fetch と同様に中断する (放置すると最大 8 秒待つだけで害は無いが、
  // 陳腐化したリクエストを持ち越さない既存方針に合わせる)。abort しても server
  // 側の touch 自体は止まらない点は終了 PATCH と同じで、結果は start 側の
  // generation ガードが破棄する。
  const fenceAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(sessionId);
  // Codex P1 (fix 2 / fix 4) + P2 (fix 4): start() の async continuation や
  // 進行中 flush を、session 切替 / stopBeforeSessionEnd / unmount で確実に
  // 無効化するための世代カウンタ。session 切替 / stop で必ず +1 する。
  const recorderGenerationRef = useRef<number>(0);

  // sessionId が変わったら ref に同期 (effect cleanup ロジック用)
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const safeSetState = useCallback(<T,>(setter: (v: T) => void, value: T) => {
    if (!mountedRef.current) return;
    setter(value);
  }, []);

  // ---- buffer flush ------------------------------------------------------

  const flushBuffer = useCallback((): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return Promise.resolve(false);
    if (inFlightFlushRef.current) {
      // 既存 in-flight が走っている場合、新規 flush は開始しない。
      // 呼び出し側が「完了まで待ちたい」場合は inFlightFlushPromiseRef を await する。
      return Promise.resolve(false);
    }
    if (bufferRef.current.length === 0) return Promise.resolve(false);
    inFlightFlushRef.current = true;
    safeSetState(setIsFlushing, true);
    // Codex P1 (fix 1 / fix 4): flush 開始時の sid と世代を捕捉し、レスポンス
    // 反映時に session 切替 / stop が起きていないか再確認する。
    const startSid = sid;
    const startGeneration = recorderGenerationRef.current;
    // Codex P1: snapshot は server API の batch 上限 (= 200) 以内に必ず chunk 化する。
    // 全件投入すると、200 超で永続 422 になり buffer を排出できなくなる。
    // 残った点は次回 flush / final flush で送る。
    const snapshot = bufferRef.current.slice(
      0,
      FIELD_SURVEY_FLUSH_API_BATCH_LIMIT,
    );
    const ac = new AbortController();
    flushAbortRef.current = ac;
    const work = (async (): Promise<boolean> => {
      try {
        const f = options.fetcher ?? fetch;
        const res = await f(
          `/api/field-survey/sessions/${encodeURIComponent(startSid)}/track-points`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: POST_HEADERS,
            body: JSON.stringify({ points: snapshot }),
            signal: ac.signal,
          },
        );
        if (!mountedRef.current) return false;
        // session 切替 / stop が起きていたら新セッションの state を汚染しない。
        if (
          sessionIdRef.current !== startSid ||
          recorderGenerationRef.current !== startGeneration
        ) {
          return false;
        }
        if (!res.ok) {
          // status のみで汎用文言に変換 (本文は読まない / console に出さない)
          safeSetState(setError, mapHttpErrorToMessage(res.status));
          return false;
        }
        // 成功した snapshot を buffer から取り除く (途中で push された分は残す)
        const sent = new Set(snapshot.map((p) => p.sequence));
        bufferRef.current = bufferRef.current.filter(
          (p) => !sent.has(p.sequence),
        );
        safeSetState(setBufferedCount, bufferRef.current.length);
        // pendingPoints (polyline 用) も同様に同期。座標値は state 化されるが
        // 表示用 (Polyline path) であって console / error には流出しない。
        safeSetState(setPendingPoints, snapshotPending(bufferRef.current));
        const accepted: RecorderPoint[] = snapshot.map((p) => ({
          sequence: p.sequence,
          lat: p.lat,
          lng: p.lng,
        }));
        if (mountedRef.current) {
          setSavedPoints((prev) => mergeBySequence(prev, accepted));
        }
        const now = new Date();
        lastFlushAtMsRef.current = now.getTime();
        safeSetState(setLastFlushAt, now);
        safeSetState(setError, null);
        return true;
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) return false;
        if (
          sessionIdRef.current !== startSid ||
          recorderGenerationRef.current !== startGeneration
        ) {
          return false;
        }
        // raw error / response 全文は出さず汎用文言のみ。
        safeSetState(setError, "位置情報の送信に失敗しました。");
        return false;
      } finally {
        inFlightFlushRef.current = false;
        safeSetState(setIsFlushing, false);
      }
    })();
    inFlightFlushPromiseRef.current = work;
    // 自分が登録した promise だけを片付ける (世代越えで上書きされた場合は触らない)。
    // 自己参照 TDZ を避けるため、後段の .finally() で work を参照する。
    void work.finally(() => {
      if (inFlightFlushPromiseRef.current === work) {
        inFlightFlushPromiseRef.current = null;
      }
    });
    return work;
  }, [options, safeSetState]);

  // ---- fetch existing route ---------------------------------------------

  /**
   * 既存 track points を全ページ取得する pure 寄り版。
   *  - state は触らない (setSavedPoints / setError しない)。
   *  - 呼び出し側 (start) が ok / session 不変を再確認してから state 反映する。
   *    fetch 中に session 切替 / 終了が起きると buffer / sequence が新セッションへ
   *    漏れる事故を防ぐ (Codex P1 fix 2)。
   */
  const fetchExistingTrackPoints = useCallback(async (): Promise<{
    ok: boolean;
    lastSequence: number | null;
    points: RecorderPoint[];
    httpStatus?: number;
  }> => {
    const sid = sessionIdRef.current;
    if (!sid) return { ok: false, lastSequence: null, points: [] };
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const ac = new AbortController();
    fetchAbortRef.current = ac;
    const f = options.fetcher ?? fetch;
    let cursor: number | null = null;
    let lastSeq: number | null = null;
    const all: RecorderPoint[] = [];
    try {
      for (let i = 0; i < FIELD_SURVEY_FETCH_PAGE_MAX; i++) {
        const params = new URLSearchParams({
          limit: String(FIELD_SURVEY_FETCH_PAGE_LIMIT),
        });
        if (cursor !== null) params.set("cursorSequence", String(cursor));
        const res = await f(
          `/api/field-survey/sessions/${encodeURIComponent(sid)}/track-points?${params.toString()}`,
          { credentials: "same-origin", signal: ac.signal },
        );
        if (!mountedRef.current) {
          return { ok: false, lastSequence: null, points: [] };
        }
        if (!res.ok) {
          return {
            ok: false,
            lastSequence: null,
            points: [],
            httpStatus: res.status,
          };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: ApiTrackPointRow[]; nextCursor?: number | null }
          | null;
        if (!mountedRef.current) {
          return { ok: false, lastSequence: null, points: [] };
        }
        const rows = Array.isArray(body?.data) ? body!.data : [];
        for (const r of rows) {
          if (
            typeof r.sequence === "number" &&
            Number.isFinite(r.lat) &&
            Number.isFinite(r.lng)
          ) {
            all.push({ sequence: r.sequence, lat: r.lat, lng: r.lng });
            if (lastSeq === null || r.sequence > lastSeq) lastSeq = r.sequence;
          }
        }
        const next = body?.nextCursor;
        if (typeof next !== "number") {
          // 全ページ取得完了。lastSeq は信頼できる。
          return { ok: true, lastSequence: lastSeq, points: all };
        }
        cursor = next;
      }
      // Codex P2 fix 2: page cap (FIELD_SURVEY_FETCH_PAGE_MAX) に到達した時点で
      // nextCursor がまだ残っている = truncated。lastSeq は DB の真の最大値より
      // 古い可能性があり、これで採番すると既存行と sequence 衝突 (skipDuplicates) して
      // client buffer が消えて保存漏れになる。確実に hard failure として扱う。
      return { ok: false, lastSequence: null, points: [] };
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current) {
        return { ok: false, lastSequence: null, points: [] };
      }
      return { ok: false, lastSequence: null, points: [] };
    }
  }, [options]);

  // ---- watchPosition lifecycle ------------------------------------------

  const handlePosition = useCallback((pos: GeolocationPosition) => {
    if (!mountedRef.current) return;
    const seq = nextSequenceRef.current;
    const candidate = normalizePosition(
      pos as unknown as Parameters<typeof normalizePosition>[0],
      seq,
    );
    if (!candidate) return;
    const recordedAtMs = new Date(candidate.recordedAt).getTime();
    setIsLowAccuracyNow(isLowAccuracy(candidate.accuracy));
    // Phase 1-F-3: TrackPoint 採用判定 (shouldAcceptCandidate) とは独立に、
    // 表示用「最新位置」は watchPosition の有効な成功 callback ごとに更新する。
    // normalizePosition が候補を返した時点で lat/lng は有限値・accuracy も
    // 上限以下が確定しているため、表示用 snapshot として安全。
    setLatestPositionForDisplay({
      lat: candidate.lat,
      lng: candidate.lng,
      accuracy: candidate.accuracy ?? null,
      capturedAt: new Date(recordedAtMs),
    });
    setLastLocationErrorForDisplay(null);
    const accept = shouldAcceptCandidate(lastAcceptedRef.current, {
      lat: candidate.lat,
      lng: candidate.lng,
      recordedAtMs,
      accuracy: candidate.accuracy,
    });
    if (!accept) return;
    nextSequenceRef.current = seq + 1;
    lastAcceptedRef.current = {
      lat: candidate.lat,
      lng: candidate.lng,
      recordedAtMs,
    };
    bufferRef.current.push(candidate);
    setBufferedCount(bufferRef.current.length);
    setPendingPoints(snapshotPending(bufferRef.current));
    if (bufferRef.current.length >= FIELD_SURVEY_FLUSH_BATCH_SIZE) {
      void flushBuffer();
    }
  }, [flushBuffer]);

  // Codex P2 (Phase 1-F-3 follow-up): 位置取得エラー / 停止 / session 切替 /
  // unmount 時に「現在地」snapshot を一括クリアする internal helper。
  // - latestPositionForDisplay を null に倒し、stale fix を「現在地として利用可能」
  //   扱いしない
  // - isWaitingForFirstLocation は status & latestPositionForDisplay の derive 値の
  //   ため、recording 中でなければ自動的に false になる
  // - 副作用は state set のみ (座標や raw payload を console / 監査経路へ流さない)
  const clearCurrentLocationDisplay = useCallback(() => {
    if (!mountedRef.current) return;
    setLatestPositionForDisplay(null);
    setIsLowAccuracyNow(false);
  }, []);

  const handlePositionError = useCallback(
    (err: GeolocationPositionError) => {
      if (!mountedRef.current) return;
      const msg = describeGeolocationError(err);
      setError(msg);
      // Phase 1-F-3: 位置「取得」失敗のみを別 state にも反映 (送信失敗とは分離)。
      setLastLocationErrorForDisplay(msg);
      // Codex P2 (本 fix): error 発生時点で「現在地として利用可能な位置」は無い扱い
      // にする。古い snapshot を残すと CurrentLocationStatus が stale fix を「最終
      // 取得」として表示し、pan ボタンも有効に残ってしまう (古い座標への panTo を
      // 許してしまう)。
      clearCurrentLocationDisplay();
      // permission denied は明確な fatal。停止して idle に戻す。
      if (err.code === 1) {
        stopWatchingInternal();
        setStatus("error");
      }
    },
    [clearCurrentLocationDisplay],
  );

  const stopWatchingInternal = useCallback(() => {
    const geo = options.geolocation ?? safeGeolocation();
    if (watchIdRef.current !== null && geo) {
      try {
        geo.clearWatch(watchIdRef.current);
      } catch {
        // 失敗しても無視 (describe しない: lat/lng/internal 流出回避)
      }
    }
    watchIdRef.current = null;
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, [options.geolocation]);

  // ---- start / stop ------------------------------------------------------

  /**
   * #317: 位置記録開始のフェンス。watch 開始前に活動 touch (PATCH touch:true)
   * を打ち、進行中/遅延中の巡回終了 commit と DB の行ロックで直列化する。
   *  - touch が先に届けば updatedAt が進み、遅延した終了 commit は活動フェンス
   *    条件 (読取時 updatedAt 一致) の不成立で失敗する → session は active の
   *    まま = 再開した記録は失われない。
   *  - 終了が先に commit していれば touch は 409 → 開始をブロックする。
   *  - 成立を確認できない失敗 (timeout/network/5xx) も開始をブロックする
   *    (@codex P1: fail-open だと touch だけ落ちて GET が通る劣化網で保護が
   *    効かない。開始は元々 GET 必須 = オフラインでは不可なので失う動作は無い)。
   * 戻り値は HTTP status (network / timeout / abort は null)。
   * 座標や応答本文は扱わない。
   */
  const touchFence = useCallback(
    async (sid: string): Promise<number | null> => {
      if (fenceAbortRef.current) fenceAbortRef.current.abort();
      const ac = new AbortController();
      fenceAbortRef.current = ac;
      const timer = setTimeout(() => ac.abort(), START_FENCE_TIMEOUT_MS);
      try {
        const f = options.fetcher ?? fetch;
        const res = await f(
          `/api/field-survey/sessions/${encodeURIComponent(sid)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: POST_HEADERS,
            // fence: true = 世代 (activitySeq) を +1 する記録開始フェンス。
            // 以後、これより古い世代をピンした終了は server 側で必ず不成立
            // になる (#317 @codex R7)。
            body: JSON.stringify({ touch: true, fence: true }),
            signal: ac.signal,
          },
        );
        if (!res.ok) return res.status;
        // #317 (@codex R9): フェンス成立 (200) でも、その直後・応答再読の前に
        // (旧タブ互換の tokenless 経路等で) 終了が commit されていると応答
        // body の status は "ended" になる。HTTP status だけで proceed すると
        // 終了済み session に記録を開始し以降の点が全て 409 で失われるため、
        // body の session status も確認する。active 以外 = 終了検知 (409 相当)。
        // 応答を解析できない場合は成立を確認できないものとして fail-closed
        // (null = blocked-retry)。
        const body = (await res.json().catch(() => null)) as
          | { data?: { status?: string } }
          | null;
        const sessStatus = body?.data?.status;
        if (sessStatus === "active") return res.status;
        if (typeof sessStatus === "string") return 409;
        return null;
      } catch {
        // network / timeout / abort → fail-open (呼び出し側が classifyStartFence
        // で proceed 扱いにする)。詳細は console に出さない。
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    [options],
  );

  const start = useCallback(() => {
    if (!sessionIdRef.current) {
      setError("巡回を開始してから位置記録を開始してください。");
      return;
    }
    if (status === "recording" || status === "preparing") return;
    const geo = options.geolocation ?? safeGeolocation();
    if (!geo) {
      setError("この端末では位置情報の利用ができません。");
      setStatus("error");
      return;
    }
    setStatus("preparing");
    setError(null);
    // Codex P1 fix 2: start 時点の session / 世代を捕捉。fetch 完了後に session
    // が切り替わっている / stop が呼ばれている / unmount されている場合は
    // watchPosition を開始しない。
    const startSessionId = sessionIdRef.current;
    const startGeneration = recorderGenerationRef.current;
    void (async () => {
      // #317 フェンス: 既存ルート取得より先に活動 touch を打つ (上記 touchFence
      // 参照)。フェンス成立 (2xx) を確認できた時のみ watch 開始へ進む (@codex P1:
      // touch だけ timeout/5xx して後続 GET が通る劣化網で fail-open すると、
      // フェンス未成立のまま記録が始まり遅延終了 commit に負ける)。
      // - blocked-ended (409/404) = 巡回は既に終了/消失 → 親へ通知して表示整合。
      // - blocked-retry (timeout/network/5xx 等) = 成立不明 → 開始せず再試行案内。
      const fenceStatus = await touchFence(startSessionId);
      if (!mountedRef.current) return;
      if (
        sessionIdRef.current !== startSessionId ||
        recorderGenerationRef.current !== startGeneration
      ) {
        return;
      }
      const fence = classifyStartFence(fenceStatus);
      if (fence === "blocked-ended") {
        setError(mapHttpErrorToMessage(fenceStatus ?? 409));
        setStatus("idle");
        options.onSessionEnded?.();
        return;
      }
      if (fence === "blocked-retry") {
        setError(
          "位置情報の記録を開始できませんでした。通信状態を確認して、もう一度お試しください。",
        );
        setStatus("idle");
        return;
      }
      const r = await fetchExistingTrackPoints();
      if (!mountedRef.current) return;
      // session / 世代の不変条件を再確認
      if (
        sessionIdRef.current !== startSessionId ||
        recorderGenerationRef.current !== startGeneration ||
        !startSessionId
      ) {
        // status は session-change 効果側で既に idle に戻されているはず。
        return;
      }
      // Codex P1 fix 3: fetch 失敗時は sequence 不明のまま記録開始しない。
      // (既存 track points がある状態で sequence=0 から再開すると
      //  skipDuplicates により client buffer が消えて保存漏れになる)。
      if (!r.ok) {
        setError(
          "既存の巡回ルートを確認できなかったため、位置記録を開始できませんでした。再度お試しください。",
        );
        setStatus("idle");
        return;
      }
      // ok=true で初めて saved 反映 + sequence 採番。
      setSavedPoints(r.points);
      // Codex P2 fix 1: 前回 flush 失敗で bufferRef.current に未送信 sequence が
      // 残っている可能性がある。server lastSequence だけで採番すると buffer 内
      // sequence と衝突 → POST 時 skipDuplicates で消滅し保存漏れ。
      // max(serverNext, bufferNext) で「server 既存 + memory 未送信」両方を
      // 越える値から再開する。
      const serverNext = nextSequence(r.lastSequence);
      const bufferNext = nextSequence(maxSequenceFromBuffer(bufferRef.current));
      nextSequenceRef.current = Math.max(serverNext, bufferNext);
      let id: number;
      try {
        id = geo.watchPosition(handlePosition, handlePositionError, {
          enableHighAccuracy: true,
          maximumAge: 5_000,
          timeout: 30_000,
        });
      } catch {
        setError("位置情報の取得を開始できませんでした。");
        setStatus("error");
        return;
      }
      // watchPosition 取得直後にも再確認 (await 直後の同期窓は短いが、
      // geo.watchPosition の同期処理中に他 effect が走るケースに備える)。
      if (
        !mountedRef.current ||
        sessionIdRef.current !== startSessionId ||
        recorderGenerationRef.current !== startGeneration
      ) {
        try {
          geo.clearWatch(id);
        } catch {
          // 流出回避: 詳細は出さない
        }
        return;
      }
      watchIdRef.current = id;
      // flush 周期タイマー
      if (flushTimerRef.current !== null) clearInterval(flushTimerRef.current);
      flushTimerRef.current = setInterval(() => {
        const now = Date.now();
        if (
          shouldFlushNow(
            bufferRef.current,
            lastFlushAtMsRef.current,
            now,
            undefined,
            inFlightFlushRef.current,
          )
        ) {
          void flushBuffer();
        }
      }, FIELD_SURVEY_FLUSH_INTERVAL_MS);
      setStatus("recording");
    })();
  }, [
    fetchExistingTrackPoints,
    flushBuffer,
    handlePosition,
    handlePositionError,
    options,
    status,
    touchFence,
  ]);

  /**
   * Codex P1: stop / stopBeforeSessionEnd の final flush は単発ではなく
   * bufferRef.current が空になるまで chunk (= 最大 200 件) ずつ送る。
   *
   * - 進捗 (buffer 件数の減少) が無くなったら break (無限ループ防止)
   * - flushBuffer が false を返した時も break (HTTP error / abort / 0件など)
   * - 戻り値: true = 完全に排出 / false = 残バッファあり
   * - lat/lng / raw response を console / error に流さない
   */
  const flushAllBufferedChunks = useCallback(async (): Promise<boolean> => {
    // @codex P2: drain 全体を generation でガードする。abort / discard /
    // session 切替で generation が進んだら、await 明けや各再送の前で打ち切り、
    // 新しい flushBuffer() を開始しない。これを怠ると、破棄 (abortInFlightFlush)
    // 後に本ループが新規 flush を始め、その POST は更新後 generation を捕捉する
    // ため flushBuffer 内の stale guard に掛からず、破棄予定の点を送ってしまう。
    const myGeneration = recorderGenerationRef.current;
    // 既存 in-flight flush の完了を先に待つ
    const inflight = inFlightFlushPromiseRef.current;
    if (inflight) {
      try {
        await inflight;
      } catch {
        // raw error / response は出さない
      }
      if (!mountedRef.current) return false;
      if (recorderGenerationRef.current !== myGeneration) return false;
    }
    // 進捗のあるうちは chunk を送り続ける
    while (bufferRef.current.length > 0) {
      // 各再送の前に generation を確認 (途中の abort / discard で打ち切る)
      if (recorderGenerationRef.current !== myGeneration) break;
      const before = bufferRef.current.length;
      let ok = false;
      try {
        ok = await flushBuffer();
      } catch {
        ok = false;
      }
      if (!mountedRef.current) return false;
      // 送信の応答が返る間に generation が進んでいたら以降の再送はしない
      if (recorderGenerationRef.current !== myGeneration) break;
      const after = bufferRef.current.length;
      if (!ok) break;
      if (after >= before) break;
    }
    return bufferRef.current.length === 0;
  }, [flushBuffer]);

  const stop = useCallback(async () => {
    if (status === "idle") return;
    setStatus("stopping");
    // start() の async continuation を無効化 + watch / timer 即時遮断
    recorderGenerationRef.current += 1;
    stopWatchingInternal();
    // Codex P1: 残 buffer を 200 件 chunk で空になるまで排出 (in-flight も内部で await)
    await flushAllBufferedChunks();
    if (!mountedRef.current) return;
    setStatus("idle");
    // Codex P2 (Phase 1-F-3): 停止後に「現在地」セクションが古い fix を「最後の取得値」
    // として表示 / pan ボタンが有効に残らないよう、表示用 state も明示クリアする。
    setLatestPositionForDisplay(null);
    setLastLocationErrorForDisplay(null);
  }, [flushAllBufferedChunks, status, stopWatchingInternal]);

  /**
   * 巡回終了直前の連動。
   *
   * Codex P1 (本 fix): status === "idle" でも、bufferRef / in-flight flush /
   * inFlightFlushRef のいずれかに未送信 work が残っていれば drain を試みる。
   * 「位置記録停止」後に final flush が失敗して buffer が残った状態を idle で
   * 早期 true してしまうと、session end PATCH 後に track-points API が active
   * のみを受け付けるため未送信点が完全に失われる。
   *
   * 順序:
   *  1) idle かつ未送信 work が無い場合のみ true 早期 return (no-op)
   *  2) status が idle 以外なら stopping に遷移
   *  3) 世代カウンタを進めて start() の async continuation を無効化
   *  4) clearWatch + flush timer 停止
   *  5) flushAllBufferedChunks() で in-flight 完了 + 残 chunk を排出
   *  6) status を idle に倒す
   *  7) drained === true で true / false で残 buffer ありの旨を返す。
   *     呼び出し側 (TripControls) は false で session end PATCH を抑止する。
   */
  const hasBufferedWork = useCallback((): boolean => {
    if (bufferRef.current.length > 0) return true;
    if (inFlightFlushRef.current) return true;
    if (inFlightFlushPromiseRef.current !== null) return true;
    return false;
  }, []);

  const stopBeforeSessionEnd = useCallback(async (): Promise<boolean> => {
    // Codex P1: idle でも未送信 work があれば drain に進む。
    if (status === "idle" && !hasBufferedWork()) return true;
    if (status !== "idle" && status !== "stopping") {
      setStatus("stopping");
    }
    recorderGenerationRef.current += 1;
    const myGeneration = recorderGenerationRef.current;
    stopWatchingInternal();
    const drained = await flushAllBufferedChunks();
    if (!mountedRef.current) return drained;
    // @codex P2: 別経路 (abortInFlightFlush / discardBufferAndStop など) で
    // generation が進んでいたら、この呼び出しは陳腐化しているので UI state を
    // 触らない (timeout race に負けた drain が遅れて完了し、破棄経路の表示を
    // 上書きするのを防ぐ)。
    if (recorderGenerationRef.current !== myGeneration) return drained;
    if (!drained) {
      // 座標を含めない汎用文言。API status / 件数 / 内部詳細は出さない。
      setError(
        "未送信の位置情報が残っているため、巡回終了前に再度送信してください。",
      );
    }
    setStatus("idle");
    // Codex P2 (Phase 1-F-3): 巡回終了直前の停止でも表示用 state を明示クリア。
    // session 切替 effect で reset されるとはいえ、PATCH 失敗時に session が
    // active のまま残るケースで stale fix を表示しないよう保険として倒す。
    setLatestPositionForDisplay(null);
    setLastLocationErrorForDisplay(null);
    return drained;
  }, [
    flushAllBufferedChunks,
    hasBufferedWork,
    status,
    stopWatchingInternal,
  ]);

  // 進行中の flush を即座に無効化・中断する (buffer は保持する)。
  // @codex P2: 「破棄して終了」で、flush の timeout race に負けて裏で走り続けて
  // いる drain が遅れて応答し、破棄すると決めた点を送信/buffer から除去して
  // しまうのを防ぐ。generation を進めて遅延応答の buffer 反映を無効化し、
  // in-flight fetch を abort する。buffer / bufferedCount は保持し、終了 PATCH の
  // 成否確定後に破棄 (成功) / 保全 (失敗) する。fetch は新規に呼ばない。
  const abortInFlightFlush = useCallback((): void => {
    recorderGenerationRef.current += 1;
    if (flushAbortRef.current) {
      flushAbortRef.current.abort();
      flushAbortRef.current = null;
    }
    inFlightFlushRef.current = false;
    inFlightFlushPromiseRef.current = null;
    if (!mountedRef.current) return;
    setIsFlushing(false);
    // @codex P2 R6/R7: 破棄 PATCH は最大 15 秒かかり得る。その間に status が idle
    // だと LocationRecorderControls が開始ボタンを出し、ユーザーが新しい watch を
    // 始められてしまう (その後 PATCH 成功で discardBufferAndStop が新規点まで消す)。
    // 直前の flush が timeout でハングした場合は status="stopping" のままだが、
    // 通常失敗 (fast reject) した場合は stopBeforeSessionEnd が完了して idle を
    // セットしているため、ここで明示的に "stopping" (非 startable) に倒す。PATCH
    // 確定後、成功なら discardBufferAndStop、失敗なら restoreIdleAfterFailedEnd で
    // idle に戻す。buffer は保持する。
    setStatus("stopping");
  }, []);

  // 破棄経路で終了 PATCH が失敗した時、buffer を保持したまま recorder を操作可能
  // (idle) に戻す。abortInFlightFlush で "stopping" 固着にした recorder を、終了が
  // 成立しなかった場合にのみ復帰させ、ユーザーが記録を再開/再試行できるようにする。
  const restoreIdleAfterFailedEnd = useCallback((): void => {
    if (!mountedRef.current) return;
    setStatus("idle");
  }, []);

  // @codex P1: 終了処理が「曖昧」な間、recorder を "stopping" (非 startable) に
  // する。通常終了では stopBeforeSessionEnd の flush 成功で status="idle" に
  // なっているため、PATCH が commit 済みだが応答喪失 + reconcile も unknown の
  // 場合、active に戻すと「位置記録開始」が再露出し、終了済み session に記録して
  // 409 で失われる。終了確定まで新 watch を開始させないよう明示的に倒す。
  // @codex R13: watch 停止 + generation bump + in-flight abort も行い、直前に
  // 紛れ込んで開始された watch を止め、不可視で走り続けないようにする (buffer は
  // 保持し、終了確定時に破棄 / active reconcile 後に委ねる)。reconcile が active
  // を確認したら restoreIdleAfterFailedEnd で idle に戻す。
  const blockRecorderForPendingEnd = useCallback((): void => {
    recorderGenerationRef.current += 1;
    stopWatchingInternal();
    if (flushAbortRef.current) {
      flushAbortRef.current.abort();
      flushAbortRef.current = null;
    }
    // #317: 進行中の開始フェンス touch も中断する (紛れ込んだ開始操作の残骸を
    // 持ち越さない。結果の破棄自体は start 側の generation ガードが行う)。
    if (fenceAbortRef.current) {
      fenceAbortRef.current.abort();
      fenceAbortRef.current = null;
    }
    inFlightFlushRef.current = false;
    inFlightFlushPromiseRef.current = null;
    if (!mountedRef.current) return;
    setIsFlushing(false);
    setStatus("stopping");
  }, [stopWatchingInternal]);

  // 未送信の位置記録を破棄して即時停止する (圏外時の巡回終了の脱出口)。
  // generation bump で in-flight flush の遅延応答も無効化する。fetch は呼ばない。
  const discardBufferAndStop = useCallback((): void => {
    recorderGenerationRef.current += 1;
    if (flushAbortRef.current) {
      flushAbortRef.current.abort();
      flushAbortRef.current = null;
    }
    if (fenceAbortRef.current) {
      fenceAbortRef.current.abort();
      fenceAbortRef.current = null;
    }
    stopWatchingInternal();
    bufferRef.current = [];
    inFlightFlushRef.current = false;
    inFlightFlushPromiseRef.current = null;
    if (!mountedRef.current) return;
    setBufferedCount(0);
    setPendingPoints([]);
    setIsFlushing(false);
    setStatus("idle");
    setError(null);
    setLatestPositionForDisplay(null);
    setLastLocationErrorForDisplay(null);
  }, [stopWatchingInternal]);

  // ---- session change / unmount cleanup ---------------------------------

  // Codex P2 fix 4: sessionId が変わったら null / non-null を問わず必ず reset
  // する。A → B のような non-null 直接切替で A の watch / buffer / sequence が
  // B へ持ち越されるのを防ぐ。active session 復元や切替時に自動 recording を
  // 開始しない方針は維持 (status は idle に倒し、ユーザーが明示的に「位置記録
  // 開始」を押すまで watchPosition は起動しない)。
  useEffect(() => {
    // 古い start() continuation / in-flight flush の state 反映を無効化
    recorderGenerationRef.current += 1;
    stopWatchingInternal();
    bufferRef.current = [];
    lastAcceptedRef.current = null;
    nextSequenceRef.current = 0;
    lastFlushAtMsRef.current = null;
    if (mountedRef.current) {
      setStatus("idle");
      setBufferedCount(0);
      setSavedPoints([]);
      setPendingPoints([]);
      setLastFlushAt(null);
      setIsLowAccuracyNow(false);
      setError(null);
      // Phase 1-F-3: 現在地表示 state も session 切替で必ず reset。
      setLatestPositionForDisplay(null);
      setLastLocationErrorForDisplay(null);
    }
  }, [sessionId, stopWatchingInternal]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopWatchingInternal();
      if (fetchAbortRef.current) fetchAbortRef.current.abort();
      if (flushAbortRef.current) flushAbortRef.current.abort();
      if (fenceAbortRef.current) fenceAbortRef.current.abort();
    };
  }, [stopWatchingInternal]);

  const isWaitingForFirstLocation =
    (status === "preparing" || status === "recording") &&
    latestPositionForDisplay === null;

  return {
    status,
    savedPoints,
    pendingPoints,
    bufferedCount,
    lastFlushAt,
    isFlushing,
    isLowAccuracyNow,
    latestPositionForDisplay,
    lastLocationErrorForDisplay,
    isWaitingForFirstLocation,
    error,
    start,
    stop,
    stopBeforeSessionEnd,
    discardBufferAndStop,
    abortInFlightFlush,
    restoreIdleAfterFailedEnd,
    blockRecorderForPendingEnd,
  };
}

function snapshotPending(buffer: TrackPointInput[]): RecorderPoint[] {
  return buffer.map((p) => ({
    sequence: p.sequence,
    lat: p.lat,
    lng: p.lng,
  }));
}

function safeGeolocation(): Geolocation | null {
  if (typeof navigator === "undefined") return null;
  const g = (navigator as Navigator & { geolocation?: Geolocation }).geolocation;
  return g ?? null;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

function mapHttpErrorToMessage(status: number): string {
  if (status === 401) return "ログインが必要です。再ログインしてください。";
  if (status === 403) return "位置記録の権限がありません。";
  if (status === 404) return "巡回の情報が見つかりません。ページを再読み込みしてください。";
  if (status === 409) return "巡回の状態が変わりました。ページを再読み込みしてください。";
  if (status === 422) return "送信内容が不正です。";
  if (status >= 500 && status < 600)
    return "サーバーエラーが発生しました。時間をおいて再試行してください。";
  return "位置情報の送信に失敗しました。";
}

function mergeBySequence(
  prev: RecorderPoint[],
  add: RecorderPoint[],
): RecorderPoint[] {
  if (add.length === 0) return prev;
  const seen = new Set(prev.map((p) => p.sequence));
  const next = prev.slice();
  for (const a of add) {
    if (!seen.has(a.sequence)) {
      next.push(a);
      seen.add(a.sequence);
    }
  }
  next.sort((a, b) => a.sequence - b.sequence);
  return next;
}
