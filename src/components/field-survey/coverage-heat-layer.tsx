"use client";

/**
 * 踏破ヒート（巡回で歩いた場所の蓄積）を地図に「面の色」として敷く層。
 *
 * 業務目的: 街を歩いて目視で古い家を探すので、短期間に同じ道を二度歩くのは無駄。
 * どこを踏破済みかを全社合計の色で見て、次に回るエリアを決める。
 *
 * 実装の方針は route-polyline.tsx と同じ:
 * - @vis.gl/react-google-maps は Polygon component を提供しないため、
 *   `useMap()` で得た map に `google.maps.Polygon` を直接 attach する。
 * - `@types/google.maps` を依存に追加せず、必要な runtime shape だけ
 *   最小 interface で宣言し `globalThis.google` から取り出す。
 * - loader 未到達（Polygon コンストラクタが無い）なら何も描かず early return。
 * - lat / lng を console / 監査ログ / Error に出さない。
 *   （ここで扱う座標は格子番号から復元した**マスの角**であり、
 *    誰かが実際に居た生座標ではない。それでも出力はしない。）
 *
 * ⚠描画数の設計:
 * 1セル1図形にすると 50m 格子では数千個のオーバーレイになり、屋外のスマホで
 * 地図が固まる。`groupCoverageCellsByTier` で**段ごとに束ね、Polygon は最大4枚**
 * （= 色の段の数）に抑える。1枚の Polygon の `paths` に各セルの矩形リングを
 * 並べる形。
 */

import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import {
  COVERAGE_HEAT_STYLES,
  coverageCellBounds,
  groupCoverageCellsByTier,
  type CoverageCell,
  type CoverageHeatTier,
} from "@/lib/field-survey-coverage";

interface LatLngLiteralLike {
  lat: number;
  lng: number;
}

interface PolygonOptionsLike {
  /** 複数リング（各セルの矩形）を 1 図形にまとめて渡す。 */
  paths?: LatLngLiteralLike[][];
  fillColor?: string;
  fillOpacity?: number;
  strokeWeight?: number;
  strokeOpacity?: number;
  clickable?: boolean;
  zIndex?: number;
}

interface PolygonLike {
  setMap(map: unknown | null): void;
}

type PolygonCtor = new (opts: PolygonOptionsLike) => PolygonLike;

interface GoogleMapsRuntime {
  maps?: {
    Polygon?: PolygonCtor;
  };
}

function getPolygonCtor(): PolygonCtor | null {
  const g = (globalThis as unknown as { google?: GoogleMapsRuntime }).google;
  return g?.maps?.Polygon ?? null;
}

interface TierRings {
  tier: CoverageHeatTier;
  paths: LatLngLiteralLike[][];
}

export default function CoverageHeatLayer({
  cells,
  latStep,
  lngStep,
  visible,
}: {
  /** 集計 API の結果。格子番号(y,x)と回数(p)のみで、人名・日時を含まない。 */
  cells: CoverageCell[];
  /** 緯度方向の格子幅（度）。API 応答の値をそのまま使う。 */
  latStep: number;
  /** 経度方向の格子幅（度）。 */
  lngStep: number;
  /** 表示切替パネルの ON/OFF。false なら 1 枚も描かない。 */
  visible: boolean;
}) {
  const map = useMap();
  const polygonsRef = useRef<PolygonLike[]>([]);

  // 段ごとの矩形リング束。cells / 格子幅が変わったときだけ作り直し、
  // 参照同一性を保って effect の再走（= 全図形の作り直し）を抑える。
  const ringsByTier = useMemo<TierRings[]>(() => {
    // ⚠格子幅が 0 や NaN のまま矩形を作ると全セルが潰れて赤道上の線になる。
    // 応答待ち・異常値のときは黙って何も描かない（fail-closed）。
    if (!(latStep > 0) || !(lngStep > 0)) return [];
    const grouped = groupCoverageCellsByTier(cells);
    const out: TierRings[] = [];
    for (const [tier, tierCells] of grouped) {
      out.push({
        tier,
        // 1 セル = 1 リング（矩形の4点）。これを 1 枚の Polygon にまとめる。
        // ⚠格子は互いに重ならないので、リングの巻き方向や内外判定
        //（重なったリングが穴になる規則）を気にする必要はない。
        paths: tierCells.map((cell) => {
          const b = coverageCellBounds(cell, { latStep, lngStep });
          return [
            { lat: b.south, lng: b.west },
            { lat: b.north, lng: b.west },
            { lat: b.north, lng: b.east },
            { lat: b.south, lng: b.east },
          ];
        }),
      });
    }
    // 濃い段を後に描く（同 zIndex 内では後勝ちなので、重なった時に
    // 「無駄に歩いた」側が隠れない）。
    return out.sort((a, b) => a.tier - b.tier);
  }, [cells, latStep, lngStep]);

  useEffect(() => {
    if (!map) return;
    if (!visible) return;
    const Polygon = getPolygonCtor();
    if (!Polygon) return;
    // cleanup で必ず空にしているので通常は 0 件。二重生成の保険。
    if (polygonsRef.current.length === 0) {
      for (const { tier, paths } of ringsByTier) {
        const style = COVERAGE_HEAT_STYLES[tier];
        const polygon = new Polygon({
          paths,
          fillColor: style.fillColor,
          fillOpacity: style.fillOpacity,
          // ⚠枠線は引かない。50m 格子の枠線は道路名を潰し、
          // 「地図を見やすくする」という趣旨に逆行する。
          strokeWeight: 0,
          strokeOpacity: 0,
          // ⚠必ず false。地図タップは「ピンを置く」「撮影後に場所を指す」
          // ための操作で、面がタップを奪うと業務が止まる。
          clickable: false,
          // ⚠最下層。今日の軌跡・現在地・ピンは常にこの面より上に乗せる
          //（過去の面が今日の線を隠さない）。
          zIndex: 0,
        });
        polygon.setMap(map);
        polygonsRef.current.push(polygon);
      }
    }
    return () => {
      for (const polygon of polygonsRef.current) {
        polygon.setMap(null);
      }
      polygonsRef.current = [];
    };
  }, [map, visible, ringsByTier]);

  // 地図への attach は副作用のみ。DOM は作らない
  // （AdvancedMarker を 1 つも増やさない = 既存のマーカー数を変えない）。
  return null;
}
