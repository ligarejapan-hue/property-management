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
  FIELD_SURVEY_FLUSH_BATCH_SIZE,
  FIELD_SURVEY_FLUSH_INTERVAL_MS,
  describeGeolocationError,
  isLowAccuracy,
  nextSequence,
  normalizePosition,
  shouldAcceptCandidate,
  shouldFlushNow,
  type TrackPointInput,
} from "@/lib/field-survey-geolocation-util";

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
  /** ユーザー向け汎用エラー文言 (lat/lng/PII を含まない)。 */
  error: string | null;
  /** 位置記録開始。すでに recording の場合は何もしない。 */
  start: () => void;
  /** 位置記録停止。可能なら残 buffer を flush してから idle に戻す。 */
  stop: () => Promise<void>;
  /**
   * 巡回終了直前の連動フック。watch を即時 clearWatch + timer 停止し、
   * その後 1 回 flush を試みる。session API への PATCH 前に await されること
   * を想定。flush 失敗時も buffer は memory に残るだけで再 throw しない。
   */
  stopBeforeSessionEnd: () => Promise<void>;
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
}

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
    // snapshot して in-flight 中の追加点は次回 flush に回す
    const snapshot = bufferRef.current.slice();
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
        if (typeof next !== "number") break;
        cursor = next;
      }
      return { ok: true, lastSequence: lastSeq, points: all };
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

  const handlePositionError = useCallback(
    (err: GeolocationPositionError) => {
      if (!mountedRef.current) return;
      setError(describeGeolocationError(err));
      // permission denied は明確な fatal。停止して idle に戻す。
      if (err.code === 1) {
        stopWatchingInternal();
        setStatus("error");
      }
    },
    [],
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

  const start = useCallback(() => {
    if (!sessionIdRef.current) {
      setError("巡回 session が無いため位置記録を開始できません。");
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
      nextSequenceRef.current = nextSequence(r.lastSequence);
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
    options.geolocation,
    status,
  ]);

  const stop = useCallback(async () => {
    if (status === "idle") return;
    setStatus("stopping");
    // start() の async continuation を無効化 + watch / timer 即時遮断
    recorderGenerationRef.current += 1;
    stopWatchingInternal();
    // 既存 in-flight flush を await (snapshot 内を確実に送ってから final)
    const inflight = inFlightFlushPromiseRef.current;
    if (inflight) {
      try {
        await inflight;
      } catch {
        // raw error / response は出さない
      }
      if (!mountedRef.current) return;
    }
    if (bufferRef.current.length > 0) {
      try {
        await flushBuffer();
      } catch {
        // final flush 失敗は無視 (未送信点は失われる)
      }
      if (!mountedRef.current) return;
    }
    setStatus("idle");
  }, [flushBuffer, status, stopWatchingInternal]);

  /**
   * 巡回終了直前の連動。idle 中は no-op。
   *
   * Codex P1 fix 1: in-flight flush を Promise として追跡し、確実に完了を
   * 待ってから final flush を 1 回行う。古い flush の snapshot 後に追加された
   * 点も、final flush で拾われる。
   *
   * 順序:
   *  1) status を stopping にして UI を遷移
   *  2) 世代カウンタを進めて start() の async continuation を無効化
   *  3) clearWatch + flush timer 停止 (新規 callback の遮断)
   *  4) 既存 in-flight flush があれば完了まで await (raw error は出さない)
   *  5) 残った buffer を final flush 試行 (失敗時も汎用文言のみ)
   *  6) status を idle に倒す
   */
  const stopBeforeSessionEnd = useCallback(async () => {
    if (status === "idle") return;
    setStatus("stopping");
    // 古い start() の continuation を無効化 (fetch 中なら watch 開始させない)
    recorderGenerationRef.current += 1;
    stopWatchingInternal();
    // 既存 in-flight flush の完了を await (snapshot 内の点を server に届かせる)
    const inflight = inFlightFlushPromiseRef.current;
    if (inflight) {
      try {
        await inflight;
      } catch {
        // raw error / response は出さない
      }
      if (!mountedRef.current) return;
    }
    // in-flight が完了した時点で buffer に残っているのは「snapshot 後に
    // 追加された / 失敗で残った」点。final flush でこれらを送る。
    if (bufferRef.current.length > 0) {
      try {
        await flushBuffer();
      } catch {
        // 終了前 final flush の失敗は巡回終了自体を阻まない
      }
      if (!mountedRef.current) return;
    }
    setStatus("idle");
  }, [flushBuffer, status, stopWatchingInternal]);

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
    }
  }, [sessionId, stopWatchingInternal]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopWatchingInternal();
      if (fetchAbortRef.current) fetchAbortRef.current.abort();
      if (flushAbortRef.current) flushAbortRef.current.abort();
    };
  }, [stopWatchingInternal]);

  return {
    status,
    savedPoints,
    pendingPoints,
    bufferedCount,
    lastFlushAt,
    isFlushing,
    isLowAccuracyNow,
    error,
    start,
    stop,
    stopBeforeSessionEnd,
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
  if (status === 404) return "巡回 session が見つかりません。";
  if (status === 409) return "巡回 session の状態が変わりました。";
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
