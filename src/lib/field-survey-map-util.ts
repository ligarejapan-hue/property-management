/**
 * 現地調査マップ (Phase 1-E) の UI から使う純粋 helper。
 *
 * UI 側で
 *  - bbox の API クエリ文字列を作る
 *  - bbox 面積が API 上限 (緯度差・経度差 0.5 度) を超えていないか先行判定
 *  - debounce で連続 pan/zoom 時の過剰リクエストを抑制
 * 等に使う。
 *
 * APIキー / lat / lng / bbox を console や AuditLog に**漏らさない**ことを
 * 呼び出し側で徹底すること。本ファイルは数値計算と文字列組み立てのみで、
 * 副作用を一切持たない。
 */

import { FIELD_SURVEY_MAP_BBOX_MAX_DEG } from "@/lib/validators";

export interface Bbox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface BboxValidation {
  ok: boolean;
  reason?:
    | "out_of_range"
    | "inverted_lat"
    | "inverted_lng"
    | "too_large_lat"
    | "too_large_lng";
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateBbox(b: Bbox): BboxValidation {
  if (
    !isFiniteNumber(b.north) ||
    !isFiniteNumber(b.south) ||
    !isFiniteNumber(b.east) ||
    !isFiniteNumber(b.west)
  ) {
    return { ok: false, reason: "out_of_range" };
  }
  if (b.north < -90 || b.north > 90 || b.south < -90 || b.south > 90) {
    return { ok: false, reason: "out_of_range" };
  }
  if (b.east < -180 || b.east > 180 || b.west < -180 || b.west > 180) {
    return { ok: false, reason: "out_of_range" };
  }
  if (b.north < b.south) return { ok: false, reason: "inverted_lat" };
  if (b.east < b.west) return { ok: false, reason: "inverted_lng" };
  if (b.north - b.south > FIELD_SURVEY_MAP_BBOX_MAX_DEG) {
    return { ok: false, reason: "too_large_lat" };
  }
  if (b.east - b.west > FIELD_SURVEY_MAP_BBOX_MAX_DEG) {
    return { ok: false, reason: "too_large_lng" };
  }
  return { ok: true };
}

/**
 * GET /api/field-survey/map/properties?... 用の query string を組み立てる。
 * bbox は既に validateBbox を通している前提だが、ここでも数値以外を弾く。
 */
export function buildMapPropertiesQuery(
  b: Bbox,
  options?: { limit?: number; includeArchived?: boolean },
): string {
  const sp = new URLSearchParams();
  sp.set("north", String(b.north));
  sp.set("south", String(b.south));
  sp.set("east", String(b.east));
  sp.set("west", String(b.west));
  if (options?.limit !== undefined) sp.set("limit", String(options.limit));
  if (options?.includeArchived) sp.set("includeArchived", "true");
  return sp.toString();
}

/**
 * 標準的な leading=false / trailing=true の debounce。
 * 連続 pan/zoom で同じ bbox 取得を多重発火させないために使う。
 * cancel() で pending を取り消せる。
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number,
): ((...args: TArgs) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: TArgs) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/**
 * Google Maps APIキーが設定されているか。空文字 / undefined を未設定扱い。
 */
export function isGoogleMapsKeyConfigured(
  key: string | undefined | null,
): boolean {
  return typeof key === "string" && key.trim().length > 0;
}
