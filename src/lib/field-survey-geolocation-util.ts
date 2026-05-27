/**
 * 現地調査マップ Phase 1-F-2 (geolocation / TrackPoint 送信) で使う純粋 helper。
 *
 * - 副作用なし (navigator.geolocation / fetch / localStorage / IndexedDB を呼ばない)
 * - lat/lng/accuracy を console / 戻り値 / Error.message に流さない
 * - API ([id]/track-points) の zod schema と整合する正規化を行う
 *
 * 数値正規化は coerceLat / coerceLng / coerceAccuracy を再利用する。
 */

import {
  coerceAccuracy,
  coerceLat,
  coerceLng,
} from "@/lib/field-survey-map-util";

/** 連続点の最小移動距離 (m)。前回保存候補から 5m 未満なら捨てる。 */
export const FIELD_SURVEY_MIN_MOVE_METERS = 5;
/** 連続点の最小経過時間 (ms)。5m 未満でも 10 秒経過すれば候補にする。 */
export const FIELD_SURVEY_MIN_INTERVAL_MS = 10 * 1000;
/** GPS accuracy がこの値を超えたら「精度が低い」警告 UI に出す (m)。 */
export const FIELD_SURVEY_ACCURACY_WARN_M = 100;
/** accuracy 上限 (m)。API zod schema (validators.ts) と同じ。 */
export const FIELD_SURVEY_MAX_ACCURACY_M = 10_000;
/** memory buffer flush の閾値: この件数到達で即時 flush。 */
export const FIELD_SURVEY_FLUSH_BATCH_SIZE = 10;
/** memory buffer flush の閾値: この時間経過で flush (ms)。 */
export const FIELD_SURVEY_FLUSH_INTERVAL_MS = 10 * 1000;
/** GET track-points で 1 ページに取る件数 (API の上限は 1000)。 */
export const FIELD_SURVEY_FETCH_PAGE_LIMIT = 500;
/** GET track-points で辿る最大ページ数 (5000 点 = ~14h @ 10s)。 */
export const FIELD_SURVEY_FETCH_PAGE_MAX = 10;

export interface TrackPointInput {
  /** session 単位の通し番号 (0 以上の整数)。 */
  sequence: number;
  lat: number;
  lng: number;
  /** accuracy は API で optional。null は許容しない (number | undefined)。 */
  accuracy?: number;
  /** ISO8601 string。API の zod は .datetime() を要求。 */
  recordedAt: string;
}

export interface RawPositionLike {
  coords: {
    latitude: unknown;
    longitude: unknown;
    accuracy: unknown;
  };
  /** epoch ms。実機は number。 */
  timestamp?: unknown;
}

/**
 * GeolocationPosition から API 送信用 TrackPointInput に正規化する。
 *
 * - lat / lng は coerceLat / coerceLng で範囲チェック
 * - accuracy は有限 & 0 以上 & MAX 以内のみ採用 (それ以外は undefined)
 * - timestamp は number でなければ now() を使う
 * - sequence は呼び出し側で採番して渡す
 *
 * 不正座標は null を返し、呼び出し側は捨てる。
 */
export function normalizePosition(
  position: RawPositionLike,
  sequence: number,
  nowMs: number = Date.now(),
): TrackPointInput | null {
  if (!position || typeof position !== "object") return null;
  const coords = position.coords;
  if (!coords || typeof coords !== "object") return null;
  const lat = coerceLat(coords.latitude);
  const lng = coerceLng(coords.longitude);
  if (lat === null || lng === null) return null;
  const acc = coerceAccuracy(coords.accuracy);
  const accuracy =
    acc !== null && acc <= FIELD_SURVEY_MAX_ACCURACY_M ? acc : undefined;
  const tsRaw = position.timestamp;
  const ts =
    typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0
      ? tsRaw
      : nowMs;
  return {
    sequence,
    lat,
    lng,
    accuracy,
    recordedAt: new Date(ts).toISOString(),
  };
}

/**
 * 地球半径 m を用いた haversine 距離 (m)。
 * 同一点は 0。範囲チェック済前提だが NaN 入力は 0 を返す。
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  if (
    !Number.isFinite(a.lat) ||
    !Number.isFinite(a.lng) ||
    !Number.isFinite(b.lat) ||
    !Number.isFinite(b.lng)
  ) {
    return 0;
  }
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 直前に採用した点 prev と候補 next の組について、保存対象にするか判定する。
 *
 * 採用条件 (OR):
 *  - prev が無い (= 初点)
 *  - 5m 以上移動
 *  - 10 秒以上経過
 *
 * 「accuracy が大きすぎる点」は accuracy > MAX_ACCURACY (= MAX_ACCURACY_M) の
 * 場合のみ棄却する。MIN_ACCURACY_WARN は警告 UI 用で、保存判定には使わない。
 */
export function shouldAcceptCandidate(
  prev: { lat: number; lng: number; recordedAtMs: number } | null,
  next: { lat: number; lng: number; recordedAtMs: number; accuracy?: number },
  opts: {
    minMoveMeters?: number;
    minIntervalMs?: number;
    maxAccuracyMeters?: number;
  } = {},
): boolean {
  const minMove = opts.minMoveMeters ?? FIELD_SURVEY_MIN_MOVE_METERS;
  const minInterval = opts.minIntervalMs ?? FIELD_SURVEY_MIN_INTERVAL_MS;
  const maxAcc = opts.maxAccuracyMeters ?? FIELD_SURVEY_MAX_ACCURACY_M;
  if (
    next.accuracy !== undefined &&
    Number.isFinite(next.accuracy) &&
    next.accuracy > maxAcc
  ) {
    return false;
  }
  if (!prev) return true;
  const dt = next.recordedAtMs - prev.recordedAtMs;
  if (Number.isFinite(dt) && dt >= minInterval) return true;
  const dm = haversineMeters(prev, next);
  if (dm >= minMove) return true;
  return false;
}

/**
 * 経過 ms か件数で flush 判定。flush 中 (isFlushing=true) は重ねない。
 */
export function shouldFlushNow(
  buffer: { length: number },
  lastFlushAtMs: number | null,
  nowMs: number,
  opts: { flushBatchSize?: number; flushIntervalMs?: number } = {},
  isFlushing = false,
): boolean {
  if (isFlushing) return false;
  if (buffer.length === 0) return false;
  const size = opts.flushBatchSize ?? FIELD_SURVEY_FLUSH_BATCH_SIZE;
  const intervalMs = opts.flushIntervalMs ?? FIELD_SURVEY_FLUSH_INTERVAL_MS;
  if (buffer.length >= size) return true;
  if (lastFlushAtMs === null) return true;
  return nowMs - lastFlushAtMs >= intervalMs;
}

/**
 * memory buffer 内の最大 sequence を返す。空 / 無効値しか無い場合は null。
 *
 * Codex P2: failed flush 後の再開時に server lastSequence だけを基準に採番すると
 * buffer 内の未送信 sequence と衝突する。max(serverLast, bufferMax) を取るために
 * 呼び出し側でこの helper を使う。
 *
 * 入力: TrackPointInput 互換 (sequence: number) の配列。
 * 副作用なし。lat/lng/accuracy は読まない。
 */
export function maxSequenceFromBuffer(
  buffer: ReadonlyArray<{ sequence: number }>,
): number | null {
  let max: number | null = null;
  for (const p of buffer) {
    const s = p?.sequence;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0) continue;
    if (max === null || s > max) max = s;
  }
  return max;
}

/** sequence の次値。最後の sequence が null/未確定なら 0 から開始。 */
export function nextSequence(lastSequence: number | null | undefined): number {
  if (
    lastSequence === null ||
    lastSequence === undefined ||
    !Number.isFinite(lastSequence) ||
    lastSequence < 0
  ) {
    return 0;
  }
  return Math.floor(lastSequence) + 1;
}

/**
 * accuracy 値が「精度が低い」警告対象か。
 * undefined / 有限値以外は警告しない (低精度判定不能)。
 */
export function isLowAccuracy(
  accuracy: number | undefined,
  warnThreshold: number = FIELD_SURVEY_ACCURACY_WARN_M,
): boolean {
  if (accuracy === undefined) return false;
  if (!Number.isFinite(accuracy)) return false;
  return accuracy > warnThreshold;
}

/**
 * navigator.geolocation の PositionError 風オブジェクトから UI 表示用の
 * 汎用文言を返す (lat/lng/座標を含めない)。
 *
 * code 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT。
 */
export function describeGeolocationError(err: unknown): string {
  const code =
    typeof err === "object" && err !== null
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === 1) {
    return "位置情報の利用が拒否されています。ブラウザ設定で許可してください。";
  }
  if (code === 2) {
    return "現在地を取得できません。GPS の状態を確認してください。";
  }
  if (code === 3) {
    return "現在地の取得がタイムアウトしました。屋外で再試行してください。";
  }
  return "位置情報の取得に失敗しました。";
}
