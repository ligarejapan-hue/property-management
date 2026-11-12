/**
 * 国土地理院ベクトルタイル(地理院地図Vector・experimental_bvmap)から、
 * 「査定のご報告」の周辺地図のデータ(建物・道路・水面・川・線路)を作る(2026-11-11)。
 *
 * - 取りに行くのはサーバー(下書きを作るとき・確認画面の「地図を作り直す」)。資料は外へ通信しない。
 * - データは物件を原点にしたメートル座標(0.5m 単位の差分)。緯度経度は入れない。
 * - 建物の高さは国土地理院のデータにないため、種類と面積からの目安(資料に「高さはイメージ」と書く)。
 * ⚠失敗しても下書きは作られたまま(地図なしで表示できる)。緯度経度・タイルの番号はログに出さない。
 */
import { classifyRings, VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { pickStation, shortestWalk, type Station } from "./route";
import {
  clipLineToRect,
  clipPolygonToRect,
  distToSegment,
  encodeDelta,
  pointInRing,
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
/**
 * 駅・周辺施設が上の範囲の外にあるときは、そこまで範囲を広げる(2026-11-12 発注者指示「駅が 3D の地図の外に出る」)。
 * 広げすぎると資料が重くなるので上限を置く。上限を越える駅は徒歩ルートを付けない(地図の外を写さない)。
 */
export const MAP_EX_MAX = 1600;
export const MAP_EY_MAX = 1300;
/** 駅・施設の札が地図の端に寄りすぎないための余白(m)。 */
const EXTENT_MARGIN = 180;
export const MAP_DATA_VERSION = 1;
/** 取りに行くタイルの上限(範囲の計算を誤っても大量に取りに行かない)。広げた範囲の上限でも収まる数。 */
export const MAX_TILES = 80;

export type MapExtent = { ex: number; ey: number };

/** 資料の平面の地図の縦横(1080×620)と、端の札のための余白の倍率(deck.js の VX と同じ考え方)。 */
const VIEW_ASPECT = 1080 / 620;
const VIEW_PAD = 1.35;

/**
 * 物件(原点)と、物件からのメートル座標の点がすべて入る範囲(基本の大きさ以上・上限以下・50m 単位)。
 * 平面の地図は横長なので、南北に離れた点を枠に入れるには東西も広く要る(東西 = 南北の幅 × 縦横比)。
 */
export function mapExtentFor(points: ReadonlyArray<readonly [number, number]>): MapExtent {
  const up = (v: number) => Math.ceil(v / 50) * 50;
  let mx = 0;
  let my = 0;
  let y0 = 0;
  let y1 = 0;
  let x0 = 0;
  let x1 = 0;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    mx = Math.max(mx, Math.abs(x));
    my = Math.max(my, Math.abs(y));
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const ex = Math.max(MAP_EX, up(mx + EXTENT_MARGIN), up(((x1 - x0) / 2) * VIEW_PAD), up(((y1 - y0) / 2) * VIEW_PAD * VIEW_ASPECT));
  const ey = Math.max(MAP_EY, up(my + EXTENT_MARGIN));
  return { ex: Math.min(MAP_EX_MAX, ex), ey: Math.min(MAP_EY_MAX, ey) };
}

/** 点が範囲の中(端から margin m 以上内側)にあるか。 */
export const insideExtent = (p: { x: number; y: number }, e: MapExtent, margin = 60) =>
  Math.abs(p.x) <= e.ex - margin && Math.abs(p.y) <= e.ey - margin;
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
  /** 建物の中庭など(穴) [b の添字, ...輪(差分・外周と逆回り)] */
  bh: number[][];
  /** 水面の中の島など(穴) [w の添字, ...輪(差分・外周と逆回り)] */
  wh: number[][];
  /** 最寄り駅(2026-11-11)。n=駅名・x/y=物件からのメートル。見つからなければ無い。 */
  st?: { n: string; x: number; y: number };
  /** 物件から最寄り駅までの徒歩ルートの目安(差分)と、その道のり(m)。 */
  rt?: number[];
  rtm?: number;
  /** 中心の求め方(2026-11-11)。address=住所から求めた目安(資料にそう書く)。なければ gps。 */
  loc?: "gps" | "address";
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

type Poly = { outer: Pt[]; holes: Pt[][] };

/**
 * 多角形(外周と穴)を、外周=反時計回り・穴=時計回りにそろえて長方形で切る(@codex #701: 穴を塗りつぶさない)。
 * 外周が残らなければ null。小さすぎる穴は捨てる。
 */
function clipPoly(rings: Pt[][], cut: { minX: number; minY: number; maxX: number; maxY: number }, tol: number): Poly | null {
  const fix = (r: Pt[], ccw: boolean) => (signedArea(r) < 0 === ccw ? r.slice().reverse() : r);
  const one = (r: Pt[], ccw: boolean): Pt[] | null => {
    if (r.length < 3) return null;
    let x = clipPolygonToRect(fix(r, ccw), cut.minX, cut.minY, cut.maxX, cut.maxY);
    if (x.length < 3) return null;
    x = simplifyRing(x, tol);
    return x.length >= 3 && Math.abs(signedArea(x)) >= 1 ? fix(x, ccw) : null;
  };
  const outer = one(rings[0], true);
  if (!outer) return null;
  const holes = rings.slice(1).map((h) => one(h, false)).filter((h): h is Pt[] => !!h);
  return { outer, holes };
}

const polyArea = (p: Poly) => signedArea(p.outer) + p.holes.reduce((a, h) => a + signedArea(h), 0);

/** 点から多角形(穴あり)までの距離。中(穴の外)なら 0。 */
function distToPoly(pt: Pt, p: Poly): number {
  if (pointInRing(pt, p.outer) && !p.holes.some((h) => pointInRing(pt, h))) return 0;
  // 外にいる(穴の中を含む)ときは、輪の線までの距離(distToRing は輪の中なら 0 を返すので使わない)。
  const edge = (r: Pt[]) => Math.min(...r.map((a, i) => distToSegment(pt, a, r[(i + 1) % r.length])));
  return Math.min(edge(p.outer), ...p.holes.map(edge));
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** 取ってきたタイルから地図のデータを作る(通信しない・テストできる部分)。 */
export function buildMapFromTiles(
  center: { lat: number; lng: number },
  tiles: TileBuffer[],
  now = new Date(),
  opts: { station?: string | null; extent?: MapExtent } = {},
): DeckMapData {
  const proj = makeLocalProjection(center.lng, center.lat);
  const EX = opts.extent?.ex ?? MAP_EX;
  const EY = opts.extent?.ey ?? MAP_EY;
  const LINE_PAD = 30;

  const buildings: Array<{ kind: number; poly: Poly; area: number }> = [];
  const roads: number[][] = [];
  const water: Poly[] = [];
  const rivers: number[][] = [];
  const rails: Array<Array<number | string>> = [];
  const walkLines: Pt[][] = [];
  const stations: Station[] = [];

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
      // 多角形は外周と穴(中庭)に分けて持つ(穴を建物として塗らない)。
      const polys = f.type === 3 ? classifyRings(f.loadGeometry()) : chainRings(f.loadGeometry()).map((r) => [r]);
      for (const rings of polys) {
        const poly = clipPoly(rings.map((r) => r.map(c)), cut, 0.4);
        if (!poly) continue;
        const area = polyArea(poly);
        if (area < MIN_BUILDING_AREA) continue;
        buildings.push({ kind, poly, area });
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
      const ft = num(f.properties.ftCode);
      // 道路の中心線(27xx)だけ。22xx は道路の縁。rdCtg=3 は高速自動車国道等(歩けない・色を変える)。
      if (ft < 2700 || ft >= 2800 || f.type !== 2) return;
      const motorway = num(f.properties.rdCtg, 9) === 3 ? 1 : 0;
      if (!motorway) {
        for (const l of f.loadGeometry()) {
          for (const part of clipLineToRect(l.map(c), lineCut.minX, lineCut.minY, lineCut.maxX, lineCut.maxY)) walkLines.push(part);
        }
      }
      if (ft !== 2701) return;
      const width = Math.max(0, Math.min(4, num(f.properties.rnkWidth)));
      for (const d of lines(f, c)) roads.push([width, motorway, ...d]);
    });
    each("label", (f, c) => {
      const name = f.properties.knj;
      if (f.type !== 1 || typeof name !== "string" || !/駅$/.test(name)) return;
      const p = f.loadGeometry()[0]?.[0];
      if (p) stations.push({ name: name.slice(0, 40), x: c(p)[0], y: c(p)[1] });
    });
    each("waterarea", (f, c) => {
      if (f.type !== 3) return;
      for (const rings of classifyRings(f.loadGeometry())) {
        const poly = clipPoly(rings.map((r) => r.map(c)), cut, 0.8);
        if (poly) water.push(poly);
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
    const d = distToPoly([0, 0], b.poly);
    if (d < best) {
      best = d;
      target = i;
    }
  });
  if (best > TARGET_MAX_DIST_M) target = -1;

  const b = buildings.map((x, i) => [Math.round(buildingHeight(x.kind, x.area, i + 1)), x.kind, ...encodeDelta(x.poly.outer)]);
  const bh = buildings.flatMap((x, i) => x.poly.holes.map((h) => [i, ...encodeDelta(h)]).filter((h) => h.length >= 7));
  const waterKept = water.filter((x) => encodeDelta(x.outer).length >= 6);
  const w = waterKept.map((x) => encodeDelta(x.outer));
  const wh = waterKept.flatMap((x, i) => x.holes.map((h) => [i, ...encodeDelta(h)]).filter((h) => h.length >= 7));
  const out: DeckMapData = { version: MAP_DATA_VERSION, builtAt: now.toISOString(), ex: EX, ey: EY, b, p: target, r: roads, w, v: rivers, t: rails, bh, wh };
  // 最寄り駅までの徒歩ルート(目安)。駅が地図の中に無い・道がつながらなければ付けない。
  const st = pickStation(stations, opts.station);
  if (st) {
    out.st = { n: st.name, x: Math.round(st.x), y: Math.round(st.y) };
    const walk = shortestWalk(walkLines, [0, 0], [st.x, st.y]);
    if (walk && walk.meters <= 3000) {
      out.rt = encodeDelta(walk.path);
      out.rtm = walk.meters;
    }
  }
  return out;
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * 物件の周りのタイルを国土地理院から取る。データのないタイル(404)は空。それ以外の失敗は全体を失敗にする。
 * have に渡したタイル(範囲を広げる前に取ったもの)は取り直さない。
 */
export async function fetchGsiTiles(
  center: { lat: number; lng: number },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  extent: MapExtent = { ex: MAP_EX, ey: MAP_EY },
  have: TileBuffer[] = [],
): Promise<TileBuffer[]> {
  const all = tilesCovering(center.lng, center.lat, extent.ex, extent.ey);
  if (all.length === 0 || all.length > MAX_TILES) throw new Error("tile_range");
  const got = new Map(have.map((t) => [`${t.x},${t.y}`, t]));
  const out: TileBuffer[] = all.flatMap(([x, y]) => got.get(`${x},${y}`) ?? []);
  const list = all.filter(([x, y]) => !got.has(`${x},${y}`));
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
