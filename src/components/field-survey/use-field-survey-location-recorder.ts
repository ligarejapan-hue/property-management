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
  const lastFlushAtMsRef = useRef<number | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const flushAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(sessionId);

  // sessionId が変わったら ref に同期 (effect cleanup ロジック用)
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const safeSetState = useCallback(<T,>(setter: (v: T) => void, value: T) => {
    if (!mountedRef.current) return;
    setter(value);
  }, []);

  // ---- buffer flush ------------------------------------------------------

  const flushBuffer = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    if (inFlightFlushRef.current) return false;
    if (bufferRef.current.length === 0) return false;
    inFlightFlushRef.current = true;
    safeSetState(setIsFlushing, true);
    // snapshot して in-flight 中の追加点は次回 flush に回す
    const snapshot = bufferRef.current.slice();
    const ac = new AbortController();
    flushAbortRef.current = ac;
    try {
      const f = options.fetcher ?? fetch;
      const res = await f(
        `/api/field-survey/sessions/${encodeURIComponent(sid)}/track-points`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: POST_HEADERS,
          body: JSON.stringify({ points: snapshot }),
          signal: ac.signal,
        },
      );
      if (!mountedRef.current) return false;
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
      // savedPoints は polyline 用に lat/lng/sequence のみ保持
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
      safeSetState(setError, "位置情報の送信に失敗しました。");
      return false;
    } finally {
      inFlightFlushRef.current = false;
      safeSetState(setIsFlushing, false);
    }
  }, [options, safeSetState]);

  // ---- fetch existing route ---------------------------------------------

  const fetchExistingTrackPoints = useCallback(async (): Promise<{
    ok: boolean;
    lastSequence: number | null;
  }> => {
    const sid = sessionIdRef.current;
    if (!sid) return { ok: false, lastSequence: null };
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
        if (!mountedRef.current) return { ok: false, lastSequence: null };
        if (!res.ok) {
          safeSetState(setError, mapHttpErrorToMessage(res.status));
          return { ok: false, lastSequence: null };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: ApiTrackPointRow[]; nextCursor?: number | null }
          | null;
        if (!mountedRef.current) return { ok: false, lastSequence: null };
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
      if (mountedRef.current) setSavedPoints(all);
      safeSetState(setError, null);
      return { ok: true, lastSequence: lastSeq };
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current) {
        return { ok: false, lastSequence: null };
      }
      safeSetState(setError, "保存済ルートの取得に失敗しました。");
      return { ok: false, lastSequence: null };
    }
  }, [options, safeSetState]);

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
    void (async () => {
      const r = await fetchExistingTrackPoints();
      if (!mountedRef.current) return;
      // 既存 sequence の次から採番 (server side は (sessionId, sequence) unique)
      nextSequenceRef.current = nextSequence(r.lastSequence);
      try {
        const id = geo.watchPosition(handlePosition, handlePositionError, {
          enableHighAccuracy: true,
          maximumAge: 5_000,
          timeout: 30_000,
        });
        watchIdRef.current = id;
      } catch {
        setError("位置情報の取得を開始できませんでした。");
        setStatus("error");
        return;
      }
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
    stopWatchingInternal();
    if (bufferRef.current.length > 0) {
      await flushBuffer();
    }
    if (!mountedRef.current) return;
    setStatus("idle");
  }, [flushBuffer, status, stopWatchingInternal]);

  // ---- session change / unmount cleanup ---------------------------------

  useEffect(() => {
    // session が消えた / 切り替わったら強制停止。
    if (!sessionId) {
      stopWatchingInternal();
      bufferRef.current = [];
      lastAcceptedRef.current = null;
      nextSequenceRef.current = 0;
      lastFlushAtMsRef.current = null;
      if (mountedRef.current) {
        setStatus("idle");
        setBufferedCount(0);
        setSavedPoints([]);
        setLastFlushAt(null);
        setIsLowAccuracyNow(false);
      }
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
    bufferedCount,
    lastFlushAt,
    isFlushing,
    isLowAccuracyNow,
    error,
    start,
    stop,
  };
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
