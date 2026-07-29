"use client";

/**
 * 過去に歩いた道筋（線）を地図に重ねる層。
 *
 * 業務目的: 面（マス）の色は「どのあたりを回ったか」を示すが、
 *  - マス(50m)は道より広いので、通っていない裏路地まで塗られる
 *  - 点と点の間をつながないので、車移動や電波切れで虫食いになる
 * ため、**実際に歩いた筋は線でしか出せない**（ユーザー指摘 2026-07-29
 * 「以前のシステムは線で表示されていた」）。面と線は併用する。
 *
 * 実装の方針は coverage-heat-layer.tsx / route-polyline.tsx と同じ:
 * - @vis.gl/react-google-maps は Polyline component を提供しないため、
 *   `useMap()` で得た map に `google.maps.Polyline` を直接 attach する。
 * - `@types/google.maps` を依存に追加せず、必要な runtime shape だけ宣言する。
 * - loader 未到達なら何も描かず early return。
 * - lat / lng を console / 監査ログ / Error に出さない。
 *
 * ⚠**1本の巡回 = 1本の Polyline**。全部を1本にまとめると、ある巡回の終点と
 * 次の巡回の始点が直線で結ばれ、**誰も通っていない道を横切る線**が描かれる。
 * 本数は API 側（planTrackFetch）で上限を持たせている。
 */

import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import type { RoutePolylinePoint } from "@/components/field-survey/route-polyline";

/**
 * 過去の線の見た目。今日の線（青・太さ3・不透明度0.85）より**細く薄く**して、
 * 進行中の巡回が過去の線に埋もれないようにする。
 */
export const COVERAGE_TRACK_STYLE = {
  strokeColor: "#475569",
  strokeOpacity: 0.5,
  strokeWeight: 2,
} as const;

interface PolylineOptionsLike {
  path?: RoutePolylinePoint[];
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWeight?: number;
  clickable?: boolean;
  zIndex?: number;
}

interface PolylineLike {
  setMap(map: unknown | null): void;
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

export default function CoverageTracksLayer({
  lines,
  visible,
}: {
  /** 巡回ごとの点列。人名・日時・巡回IDは含まない（API が返さない）。 */
  lines: RoutePolylinePoint[][];
  /** 表示切替パネルの ON/OFF。false なら 1 本も描かない。 */
  visible: boolean;
}) {
  const map = useMap();
  const polylinesRef = useRef<PolylineLike[]>([]);

  // 描ける形だけに整える。参照同一性を保って effect の再走（= 全図形の
  // 作り直し）を抑える。
  const paths = useMemo<RoutePolylinePoint[][]>(
    () =>
      lines
        .map((line) =>
          line
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
            .map((p) => ({ lat: p.lat, lng: p.lng })),
        )
        // 点が1つでは線にならない。
        .filter((line) => line.length >= 2),
    [lines],
  );

  useEffect(() => {
    if (!map) return;
    if (!visible) return;
    const Polyline = getPolylineCtor();
    if (!Polyline) return;
    // cleanup で必ず空にしているので通常は 0 件。二重生成の保険。
    if (polylinesRef.current.length === 0) {
      for (const path of paths) {
        const polyline = new Polyline({
          path,
          ...COVERAGE_TRACK_STYLE,
          // ⚠必ず false。地図タップは「ピンを置く」「撮影後に場所を指す」
          // ための操作で、線がタップを奪うと業務が止まる。
          clickable: false,
          // 面（zIndex 0）より上、今日の線（zIndex 2）より下。
          zIndex: 1,
        });
        polyline.setMap(map);
        polylinesRef.current.push(polyline);
      }
    }
    return () => {
      for (const polyline of polylinesRef.current) {
        polyline.setMap(null);
      }
      polylinesRef.current = [];
    };
  }, [map, visible, paths]);

  // 地図への attach は副作用のみ。DOM は作らない。
  return null;
}
