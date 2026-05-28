"use client";

/**
 * 現地調査マップ Phase 1-F-3: 位置記録中の現在地マーカー。
 *
 * - @vis.gl/react-google-maps の useMap() で取得した map に
 *   google.maps.Marker を直接 attach する (vis.gl の AdvancedMarker は
 *   pointer-events 制御が緩く、pin 追加モードの map click と干渉するため
 *   採用しない)。
 * - clickable: false 固定。Map click / pin 追加モードを邪魔しない。
 * - lat / lng を console / Audit / Error に流さない。
 *
 * 型の方針:
 * - `@types/google.maps` を依存に追加しない。
 * - 必要な runtime shape (Marker / SymbolPath.CIRCLE / setMap / setPosition)
 *   のみ最小 interface で定義し、`globalThis.google` から取り出す。
 * - runtime で Marker コンストラクタが未到達なら何も描画せず early return。
 */

import { useEffect, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";

export interface CurrentLocationMarkerProps {
  lat: number;
  lng: number;
}

interface MarkerLike {
  setMap(map: unknown | null): void;
  setPosition(pos: { lat: number; lng: number }): void;
}

interface MarkerOptionsLike {
  position: { lat: number; lng: number };
  clickable?: boolean;
  zIndex?: number;
  icon?: unknown;
  title?: string;
}

type MarkerCtor = new (opts: MarkerOptionsLike) => MarkerLike;

interface GoogleMapsRuntime {
  maps?: {
    Marker?: MarkerCtor;
    SymbolPath?: { CIRCLE?: number };
  };
}

function getGoogleMaps(): GoogleMapsRuntime | null {
  return (
    (globalThis as unknown as { google?: GoogleMapsRuntime }).google ?? null
  );
}

export default function CurrentLocationMarker({
  lat,
  lng,
}: CurrentLocationMarkerProps) {
  const map = useMap();
  const markerRef = useRef<MarkerLike | null>(null);

  useEffect(() => {
    if (!map) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const g = getGoogleMaps();
    const Marker = g?.maps?.Marker;
    if (!Marker) return;
    const circleSymbol = g?.maps?.SymbolPath?.CIRCLE;
    const icon =
      typeof circleSymbol === "number"
        ? {
            path: circleSymbol,
            scale: 8,
            fillColor: "#2563eb",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
          }
        : undefined;
    if (markerRef.current === null) {
      markerRef.current = new Marker({
        position: { lat, lng },
        clickable: false,
        zIndex: 2,
        icon,
        title: "現在地",
      });
      markerRef.current.setMap(map);
    } else {
      markerRef.current.setPosition({ lat, lng });
    }
    return () => {
      if (markerRef.current) {
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
    };
  }, [map, lat, lng]);

  return null;
}
