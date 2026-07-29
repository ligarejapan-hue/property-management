"use client";

/**
 * 現地調査マップ Phase 1-F-2: 現在 active session の route polyline 表示。
 *
 * - @vis.gl/react-google-maps は Polyline component を提供しないため、
 *   `useMap()` で取得した map インスタンスに直接 google.maps.Polyline を attach する。
 * - 過去 session / 他スタッフ session の route は描画しない。
 *   呼び出し側 (FieldSurveyMap) で active session かつ自分のものに限定する。
 * - lat / lng を console / 監査ログ / Error に出さない。
 *
 * 型の方針:
 * - `@types/google.maps` を依存に追加しない (グローバル型 `google.*` に依存しない)。
 * - 必要な runtime shape (Polyline / setMap / setPath) のみ最小 interface で定義し、
 *   `globalThis.google` から取り出す。
 * - runtime で google maps loader が未到達 (Polyline コンストラクタが無い) なら
 *   何も描画せず early return する。
 */

import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";

export interface RoutePolylinePoint {
  lat: number;
  lng: number;
}

interface PolylineOptionsLike {
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWeight?: number;
  clickable?: boolean;
  zIndex?: number;
}

interface PolylineLike {
  setMap(map: unknown | null): void;
  setPath(path: RoutePolylinePoint[]): void;
}

type PolylineCtor = new (opts: PolylineOptionsLike) => PolylineLike;

interface GoogleMapsRuntime {
  maps?: {
    Polyline?: PolylineCtor;
  };
}

function getPolylineCtor(): PolylineCtor | null {
  const g = (globalThis as unknown as { google?: GoogleMapsRuntime }).google;
  return g?.maps?.Polyline ?? null;
}

export default function RoutePolyline({
  points,
}: {
  points: RoutePolylinePoint[];
}) {
  const map = useMap();
  const polylineRef = useRef<PolylineLike | null>(null);

  // useMemo で path を作って参照同一性を維持し、effect 再走を抑える。
  const path = useMemo(
    () =>
      points
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({ lat: p.lat, lng: p.lng })),
    [points],
  );

  useEffect(() => {
    if (!map) return;
    const Polyline = getPolylineCtor();
    if (!Polyline) return;
    if (polylineRef.current === null) {
      polylineRef.current = new Polyline({
        strokeColor: "#2563eb",
        strokeOpacity: 0.85,
        strokeWeight: 3,
        clickable: false,
        // ⚠**過去の線 (zIndex 1) より上**。進行中の巡回がいちばん手前に
        // 来ないと、蓄積した線の中に今日の線が埋もれて自分の位置を見失う。
        zIndex: 2,
      });
      polylineRef.current.setMap(map);
    }
    polylineRef.current.setPath(path);
    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
        polylineRef.current = null;
      }
    };
  }, [map, path]);

  return null;
}
