"use client";

/**
 * 現地調査マップ Phase 1-F-2: 現在 active session の route polyline 表示。
 *
 * - @vis.gl/react-google-maps は Polyline component を提供しないため、
 *   useMap() で取得した map に直接 google.maps.Polyline を attach する。
 * - 過去 session / 他スタッフ session の route は描画しない。
 *   呼び出し側 (FieldSurveyMap) で active session かつ自分のものに限定する。
 * - lat / lng を console / 監査ログ / Error に出さない。
 */

import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";

export interface RoutePolylinePoint {
  lat: number;
  lng: number;
}

export default function RoutePolyline({ points }: { points: RoutePolylinePoint[] }) {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);

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
    if (typeof google === "undefined" || !google?.maps?.Polyline) return;
    if (polylineRef.current === null) {
      polylineRef.current = new google.maps.Polyline({
        strokeColor: "#2563eb",
        strokeOpacity: 0.85,
        strokeWeight: 3,
        clickable: false,
        zIndex: 1,
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
