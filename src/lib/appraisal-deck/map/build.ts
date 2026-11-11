/**
 * 国土地理院ベクトルタイル(地理院地図Vector・experimental_bvmap)から、
 * 「査定のご報告」の周辺地図のデータ(建物・道路・水面・川・線路)を作る(2026-11-11)。
 *
 * - 取りに行くのはサーバー(下書きを作るとき・確認画面の「地図を作り直す」)。資料は外へ通信しない。
 * - データは物件を原点にしたメートル座標(0.5m 単位の差分)。緯度経度は入れない。
 * - 建物の高さは国土地理院のデータにないため、種類と面積からの目安(資料に「高さはイメージ」と書く)。
 * ⚠失敗しても下書きは作られたまま(地図なしで表示できる)。緯度経度・タイルの番号はログに出さない。
 */
import { VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import {
  clipLineToRect,
  clipPolygonToRect,
  distToRing,
  encodeDelta,
  makeLocalProjection,
  seededRandom,
  signedArea,
  simplifyLine,
  simplifyRing,
  tileToLonLat,
  tilesCovering,
  TILE_ZOOM,
  type Pt,
} from "./geo";

/** 地図の範囲(物件から東西 ±EX m・南北 ±EY m)。資料の 3D の動き(カメラの道すじ)はこの大きさに合わせてある。 */
export const MAP_EX = 1000;
export const MAP_EY = 650;
export const MAP_DATA_VERSION = 1;
/** 取りに行くタイルの上限(範囲の計算を誤っても大量に取りに行かない)。 */
export const MAX_TILES = 40;
export const TILE_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
/** 物件の建物とみなす距離(これより遠ければ、建物に色を付けずに地点に印だけ立てる)。 */
const TARGET_MAX_DIST_M = 25;
const MIN_BUILDING_AREA = 8;

const GSI_HOST = "cyberjapandata.gsi.go.jp";
export const gsiTileUrl = (x: number, y: number) => `https://${GSI_HOST}/xyz/experimental_bvmap/${TILE_ZOOM}/${x}/${y}.pbf`;

/** 資料に入れる地図のデータ(appraisal_decks.map_data)。 */
export type DeckMapData = {
  version: number;
  builtAt: string;
  ex: number;
  ey: number;
  /** 建物 [高さm, 種類(0普通 1堅ろう 2高層 3無壁), ...外周(差分)] */
  b: number[][];
  /** 物件の建物の番号(b の添字)。なければ -1 */
  p: number;
  /** 道路 [幅の区分0-4, 高速なら1, ...線(差分)] */
  r: number[][];
  /** 水面(差分) */
  w: number[][];
  /** 川の線(差分) */
  v: number[][];
  /** 線路 [状態(トンネルなど), ...線(差分)] */
  t: Array<Array<number | string>>;
};

export type TileBuffer = { x: number; y: number; buf: Uint8Array | null };

const BUILDING_KIND: Record<number, number> = { 3101: 0, 3102: 1, 3103: 2, 3111: 3 };

function buildingHeight(kind: number, area: number, seed: number): number {
  const r = seededRandom(seed);
  if (kind === 2) return 45 + 20 * r; // 高層建物
  if (kind === 1) return Math.min(40, 9 + area / 60 + 6 * r); // 堅ろう建物
  if (kind === 3) return 3.5; // 無壁舎
  return area < 180 ? 6.5 + 3 * r : 8 + 4 * r; // 普通建物
}

/** 線の切れ端を端点でつないで輪にする(閉じきらないものは端どうしを結ぶ=タイルの余白の外で切り落とされる)。 */
export function chainRings(parts: Array<Array<{ x: number; y: number }>>): Array<Array<{ x: number; y: number }>> {
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const rest = parts.filter((l) => l.length >= 2).map((l) => l.slice());
  const out: Array<Array<{ x: number; y: number }>> = [];
  while (rest.length) {
    let cur = rest.shift()!;
    for (let grew = true; grew && key(cur[0]) !== key(cur[cur.length - 1]); ) {
      grew = false;
      const end = key(cur[cur.length - 1]);
      const i = rest.findIndex((l) => key(l[0]) === end || key(l[l.length - 1]) === end);
      if (i >= 0) {
        const [l] = rest.splice(i, 1);
        const seg = key(l[0]) === end ? l : l.slice().reverse();
        cur = [...cur, ...seg.slice(1)];
        grew = true;
      }
    }
    if (key(cur[0]) === key(cur[cur.length - 1])) cur = cur.slice(0, -1);
    if (cur.length >= 3) out.push(cur);
  }
  return out;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** 取ってきたタイルから地図のデータを作る(通信しない・テストできる部分)。 */
export function buildMapFromTiles(center: { lat: number; lng: number }, tiles: TileBuffer[], now = new Date()): DeckMapData {
  const proj = makeLocalProjection(center.lng, center.lat);
  const EX = MAP_EX;
  const EY = MAP_EY;
  const LINE_PAD = 30;

  const buildings: Array<{ kind: number; ring: Pt[]; area: number }> = [];
  const roads: number[][] = [];
  const water: number[][] = [];
  const rivers: number[][] = [];
  const rails: Array<Array<number | string>> = [];

  for (const t of tiles) {
    if (!t.buf || t.buf.length === 0) continue;
    const vt = new VectorTile(new PbfReader(t.buf));
    const conv = (layer: VectorTileLayer) => (p: { x: number; y: number }): Pt => {
      const [lon, lat] = tileToLonLat(t.x + p.x / layer.extent, t.y + p.y / layer.extent);
      return proj.toLocal(lon, lat);
    };
    // タイルの境目で同じ建物が重ならないよう、まずタイル自身の範囲で切る(ベクトルタイルは周りに余白を持つ)。
    const [tw, tn] = proj.toLocal(...tileToLonLat(t.x, t.y));
    const [te, ts] = proj.toLocal(...tileToLonLat(t.x + 1, t.y + 1));
    const cut = { minX: Math.max(tw, -EX), maxX: Math.min(te, EX), minY: Math.max(ts, -EY), maxY: Math.min(tn, EY) };

    const each = (name: string, fn: (f: ReturnType<VectorTileLayer["feature"]>, c: (p: { x: number; y: number }) => Pt) => void) => {
      const layer = vt.layers[name];
      if (!layer) return;
      const c = conv(layer);
      for (let i = 0; i < layer.length; i++) fn(layer.feature(i), c);
    };

    each("building", (f, c) => {
      if (f.type !== 2 && f.type !== 3) return;
      const kind = BUILDING_KIND[num(f.properties.ftCode)] ?? 0;
      // 地理院のタイルは建物の外周を線(閉じた線・タイルの余白で切れた線)で持つことがある=つないで多角形にする。
      const rings = f.type === 3 ? f.loadGeometry() : chainRings(f.loadGeometry());
      for (const raw of rings) {
        let ring = raw.map(c);
        if (ring.length < 3) continue;
        if (signedArea(ring) < 0) ring = ring.reverse(); // 向きをそろえる(反時計回り)
        ring = clipPolygonToRect(ring, cut.minX, cut.minY, cut.maxX, cut.maxY);
        if (ring.length < 3) continue;
        ring = simplifyRing(ring, 0.4);
        const area = signedArea(ring);
        if (ring.length < 3 || area < MIN_BUILDING_AREA) continue;
        buildings.push({ kind, ring, area });
      }
    });
    const lineCut = { minX: Math.max(tw, -EX - LINE_PAD), maxX: Math.min(te, EX + LINE_PAD), minY: Math.max(ts, -EY - LINE_PAD), maxY: Math.min(tn, EY + LINE_PAD) };
    const lines = (f: ReturnType<VectorTileLayer["feature"]>, c: (p: { x: number; y: number }) => Pt) =>
      f.type !== 2
        ? []
        : f
            .loadGeometry()
            .flatMap((l) => clipLineToRect(l.map(c), lineCut.minX, lineCut.minY, lineCut.maxX, lineCut.maxY))
            .map((l) => encodeDelta(simplifyLine(l, 0.8)))
            .filter((d) => d.length >= 4);

    each("road", (f, c) => {
      if (num(f.properties.ftCode) !== 2701) return;
      const width = Math.max(0, Math.min(4, num(f.properties.rnkWidth)));
      const motorway = num(f.properties.motorway, 9) === 0 ? 1 : 0;
      for (const d of lines(f, c)) roads.push([width, motorway, ...d]);
    });
    each("waterarea", (f, c) => {
      if (f.type !== 3) return;
      for (const raw of f.loadGeometry()) {
        let ring = raw.map(c);
        if (ring.length < 3) continue;
        if (signedArea(ring) < 0) ring = ring.reverse();
        ring = clipPolygonToRect(ring, cut.minX, cut.minY, cut.maxX, cut.maxY);
        if (ring.length < 3) continue;
        const d = encodeDelta(simplifyRing(ring, 0.8));
        if (d.length >= 6) water.push(d);
      }
    });
    each("river", (f, c) => {
      for (const d of lines(f, c)) rivers.push(d);
    });
    each("railway", (f, c) => {
      const state = f.properties.railState;
      const st = typeof state === "string" ? state.slice(0, 20) : num(state);
      for (const d of lines(f, c)) rails.push([st, ...d]);
    });
  }

  // 物件の建物=原点を含む(なければ一番近い)建物。
  let target = -1;
  let best = Infinity;
  buildings.forEach((b, i) => {
    const d = distToRing([0, 0], b.ring);
    if (d < best) {
      best = d;
      target = i;
    }
  });
  if (best > TARGET_MAX_DIST_M) target = -1;

  const b = buildings.map((x, i) => [Math.round(buildingHeight(x.kind, x.area, i + 1)), x.kind, ...encodeDelta(x.ring)]);
  return { version: MAP_DATA_VERSION, builtAt: now.toISOString(), ex: EX, ey: EY, b, p: target, r: roads, w: water, v: rivers, t: rails };
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** 物件の周りのタイルを国土地理院から取る。データのないタイル(404)は空。それ以外の失敗は全体を失敗にする。 */
export async function fetchGsiTiles(center: { lat: number; lng: number }, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<TileBuffer[]> {
  const list = tilesCovering(center.lng, center.lat, MAP_EX, MAP_EY);
  if (list.length === 0 || list.length > MAX_TILES) throw new Error("tile_range");
  const out: TileBuffer[] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const [x, y] = list[next++];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TILE_TIMEOUT_MS);
      try {
        const res = await fetchImpl(gsiTileUrl(x, y), { signal: ctl.signal, headers: { "User-Agent": "property-management-appraisal-map/1.0" } });
        if (res.status === 404) {
          out.push({ x, y, buf: null });
          continue;
        }
        if (!res.ok) throw new Error("tile_http");
        out.push({ x, y, buf: new Uint8Array(await res.arrayBuffer()) });
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return out;
}

/** 座標が日本のあたりの正しい値か(地図を作れるか)。 */
export function isUsableLocation(lat: number | null, lng: number | null): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 20 &&
    lat <= 46 &&
    lng >= 122 &&
    lng <= 154
  );
}
