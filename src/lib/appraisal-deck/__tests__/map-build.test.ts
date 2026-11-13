/**
 * 周辺地図のデータ作り(2026-11-11)。本物のタイルは使わず、ベクトルタイルをテストの中で組み立てて確かめる。
 */
import { describe, it, expect, vi } from "vitest";
import { PbfWriter } from "pbf";
import {
  buildMapFromTiles,
  chainRings,
  fetchGsiTiles,
  insideExtent,
  isUsableLocation,
  mapExtentFor,
  MAX_TILES,
  MAP_EX,
  MAP_EX_MAX,
  MAP_EY,
  MAP_EY_MAX,
} from "../map/build";
import {
  clipLineToRect,
  clipPolygonToRect,
  encodeDelta,
  lonLatToTile,
  signedArea,
  simplifyLine,
  tilesCovering,
} from "../map/geo";

type Feat = { type: 1 | 2 | 3; props: Record<string, string | number>; parts: number[][][] };
type Layer = { name: string; features: Feat[] };

const zz = (n: number) => (n << 1) ^ (n >> 31);
function geometry(f: Feat): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const part of f.parts) {
    const [x0, y0] = part[0];
    out.push((1 & 7) | (1 << 3), zz(x0 - cx), zz(y0 - cy));
    cx = x0;
    cy = y0;
    const rest = part.slice(1);
    if (f.type === 1) continue;
    out.push((2 & 7) | (rest.length << 3));
    for (const [x, y] of rest) {
      out.push(zz(x - cx), zz(y - cy));
      cx = x;
      cy = y;
    }
    if (f.type === 3) out.push((7 & 7) | (1 << 3));
  }
  return out;
}
function makeTile(layers: Layer[]): Uint8Array {
  const pbf = new PbfWriter();
  for (const layer of layers) {
    pbf.writeMessage(
      3,
      (l: Layer, w: PbfWriter) => {
        w.writeVarintField(15, 2);
        w.writeStringField(1, l.name);
        const keys: string[] = [];
        const values: Array<string | number> = [];
        const idx = (arr: Array<string | number>, v: string | number) => {
          let i = arr.indexOf(v);
          if (i < 0) i = arr.push(v) - 1;
          return i;
        };
        for (const f of l.features) {
          const tags: number[] = [];
          for (const [k, v] of Object.entries(f.props)) tags.push(idx(keys, k), idx(values, v));
          w.writeMessage(
            2,
            (ff: Feat, ww: PbfWriter) => {
              ww.writePackedVarint(2, tags);
              ww.writeVarintField(3, ff.type);
              ww.writePackedVarint(4, geometry(ff));
            },
            f,
          );
        }
        for (const k of keys) w.writeStringField(3, k);
        for (const v of values)
          w.writeMessage(
            4,
            (vv: string | number, ww: PbfWriter) => (typeof vv === "string" ? ww.writeStringField(1, vv) : ww.writeSVarintField(6, vv)),
            v,
          );
        w.writeVarintField(5, 4096);
      },
      layer,
    );
  }
  return pbf.finish();
}

// 架空の地点(海の上ではない座標なら何でもよい)。
const C = { lat: 35.65, lng: 139.7 };
const [ftx, fty] = lonLatToTile(C.lng, C.lat);
const TX = Math.floor(ftx);
const TY = Math.floor(fty);
const PX = Math.round((ftx - TX) * 4096);
const PY = Math.round((fty - TY) * 4096);
/** 物件の位置(タイルの中の点)から dx,dy(タイルの点=約0.12m)ずらした正方形(画面の向き=時計回り)。 */
const square = (dx: number, dy: number, r: number) => [
  [PX + dx - r, PY + dy - r],
  [PX + dx + r, PY + dy - r],
  [PX + dx + r, PY + dy + r],
  [PX + dx - r, PY + dy + r],
];

describe("座標の計算", () => {
  it("多角形を長方形で切る", () => {
    const r = clipPolygonToRect(
      [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      0,
      0,
      10,
      10,
    );
    expect(signedArea(r)).toBeCloseTo(25);
  });
  it("折れ線は外に出た所で分かれる", () => {
    const parts = clipLineToRect(
      [
        [-5, 1],
        [5, 1],
        [5, 20],
        [8, 20],
        [8, 2],
      ],
      0,
      0,
      10,
      10,
    );
    expect(parts).toEqual([
      [
        [0, 1],
        [5, 1],
        [5, 10],
      ],
      [
        [8, 10],
        [8, 2],
      ],
    ]);
  });
  it("間引き・差分の並び(0.5m 単位)", () => {
    expect(
      simplifyLine(
        [
          [0, 0],
          [1, 0.01],
          [2, 0],
        ],
        0.1,
      ),
    ).toEqual([
      [0, 0],
      [2, 0],
    ]);
    expect(
      encodeDelta([
        [1, 1],
        [1.1, 1.1],
        [3, 1],
      ]),
    ).toEqual([2, 2, 4, 0]);
  });
  it("覆うタイルの数は範囲に見合う(上限より少ない)", () => {
    const t = tilesCovering(C.lng, C.lat, MAP_EX, MAP_EY);
    expect(t.length).toBeGreaterThan(4);
    expect(t.length).toBeLessThanOrEqual(MAX_TILES);
  });
  it("広げた範囲の上限でも、覆うタイルは上限以下(2026-11-12)", () => {
    expect(tilesCovering(C.lng, C.lat, MAP_EX_MAX, MAP_EY_MAX).length).toBeLessThanOrEqual(MAX_TILES);
    // 北海道の北の方(タイルが細くなる)でも
    expect(tilesCovering(141.7, 45.4, MAP_EX_MAX, MAP_EY_MAX).length).toBeLessThanOrEqual(MAX_TILES);
  });
  it("線の切れ端をつないで輪にする", () => {
    const p = (x: number, y: number) => ({ x, y });
    const rings = chainRings([
      [p(0, 0), p(10, 0)],
      [p(10, 10), p(10, 0)],
      [p(10, 10), p(0, 10), p(0, 0)],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });
});

describe("buildMapFromTiles", () => {
  const tile = makeTile([
    {
      name: "building",
      features: [
        { type: 3, props: { ftCode: 3101 }, parts: [square(0, 0, 60)] }, // 物件の建物(約14m四方)
        { type: 2, props: { ftCode: 3102 }, parts: [[...square(400, 0, 60), square(400, 0, 60)[0]]] }, // 閉じた線の建物
        {
          type: 2,
          props: { ftCode: 3101 },
          parts: [
            [square(-400, 0, 60)[0], square(-400, 0, 60)[1], square(-400, 0, 60)[2]],
            [square(-400, 0, 60)[2], square(-400, 0, 60)[3], square(-400, 0, 60)[0]],
          ],
        }, // 2つに切れた線の建物
        { type: 3, props: { ftCode: 3101 }, parts: [square(0, 400, 5)] }, // 小さすぎる(物置)
      ],
    },
    {
      name: "road",
      features: [
        { type: 2, props: { ftCode: 2701, rnkWidth: 2, rdCtg: 3 }, parts: [[[PX - 800, PY + 200], [PX + 800, PY + 200]]] },
        { type: 2, props: { ftCode: 2703, rnkWidth: 1 }, parts: [[[PX - 800, PY + 300], [PX + 800, PY + 300]]] },
      ],
    },
    { name: "railway", features: [{ type: 2, props: { railState: "トンネル" }, parts: [[[PX - 800, PY - 300], [PX + 800, PY - 300]]] }] },
    { name: "waterarea", features: [{ type: 3, props: {}, parts: [square(0, -600, 100)] }] },
  ]);
  const map = buildMapFromTiles(C, [{ x: TX, y: TY, buf: tile }, { x: TX + 1, y: TY, buf: null }], new Date("2026-11-11T00:00:00Z"));

  it("建物(多角形・閉じた線・切れた線)を拾い、小さすぎるものは捨てる", () => {
    expect(map.b).toHaveLength(3);
    expect(map.b.map((b) => b[1]).sort()).toEqual([0, 0, 1]);
    for (const b of map.b) expect(b[0]).toBeGreaterThan(0); // 高さ(目安)
  });
  it("物件の建物は原点を含む建物", () => {
    expect(map.p).toBeGreaterThanOrEqual(0);
    const b = map.b[map.p];
    expect(b[1]).toBe(0);
  });
  it("道路は中心線(2701)だけ描く(幅の区分・高速=rdCtg 3 の印)、線路・水面も入る", () => {
    expect(map.r).toHaveLength(1);
    expect(map.r[0].slice(0, 2)).toEqual([2, 1]);
    expect(map.t[0][0]).toBe("トンネル");
    expect(map.w).toHaveLength(1);
  });
  it("座標は整数(0.5m 単位の差分)だけ=緯度経度は入らない", () => {
    expect(Object.keys(map).sort()).toEqual(["b", "bh", "builtAt", "ex", "ey", "p", "r", "t", "v", "version", "w", "wh"]);
    for (const arr of [...map.b, ...map.r, ...map.w, ...map.v, ...map.bh, ...map.wh]) for (const n of arr) expect(Number.isInteger(n)).toBe(true);
    expect(JSON.stringify(map)).not.toMatch(/35\.6|139\.7/);
  });
  it("同じタイルなら同じ地図(作り直しても変わらない)", () => {
    const again = buildMapFromTiles(C, [{ x: TX, y: TY, buf: tile }], new Date("2026-11-11T00:00:00Z"));
    expect(again.b).toEqual(map.b);
  });
  it("中庭のある建物・島のある水面は穴を保つ(穴を塗らない・穴の中は建物の外・@codex #701)", () => {
    const outer = square(0, 0, 600); // 約145m 四方
    const hole = square(0, 0, 300).slice().reverse(); // 穴は外周と逆回り。原点(物件)は中庭の中
    const t2 = makeTile([
      { name: "building", features: [{ type: 3, props: { ftCode: 3102 }, parts: [outer, hole] }] },
      { name: "waterarea", features: [{ type: 3, props: {}, parts: [square(0, -1500, 400), square(0, -1500, 100).slice().reverse()] }] },
    ]);
    const m = buildMapFromTiles(C, [{ x: TX, y: TY, buf: t2 }]);
    expect(m.b).toHaveLength(1);
    expect(m.bh).toHaveLength(1);
    expect(m.bh[0][0]).toBe(0);
    expect(m.w).toHaveLength(1);
    expect(m.wh).toHaveLength(1);
    expect(m.p).toBe(-1); // 中庭の真ん中(建物から約36m)は物件の建物とみなさない
    // 穴は外周と逆回り(塗りの規則 nonzero で穴になる)
    const ring = (d: number[], s0: number) => {
      const o: Array<[number, number]> = [];
      let x = 0;
      let y = 0;
      for (let i = s0; i < d.length; i += 2) {
        x += d[i];
        y += d[i + 1];
        o.push([x, y]);
      }
      return o;
    };
    expect(Math.sign(signedArea(ring(m.b[0], 2)))).toBe(-Math.sign(signedArea(ring(m.bh[0], 1))));
  });
  it("近くに建物がなければ物件の建物はなし(-1)", () => {
    const far = makeTile([{ name: "building", features: [{ type: 3, props: { ftCode: 3101 }, parts: [square(1500, 1500, 60)] }] }]);
    expect(buildMapFromTiles(C, [{ x: TX, y: TY, buf: far }]).p).toBe(-1);
  });
});

describe("fetchGsiTiles", () => {
  it("国土地理院のタイルだけを取りに行き、データのないタイル(404)は空にする", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: !urls.length || urls.length % 2 === 0, status: urls.length % 2 === 0 ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(4) };
    });
    const tiles = await fetchGsiTiles(C, f);
    expect(tiles.length).toBe(tilesCovering(C.lng, C.lat, MAP_EX, MAP_EY).length);
    expect(urls.every((u) => u.startsWith("https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/16/"))).toBe(true);
    expect(tiles.some((t) => t.buf === null)).toBe(true);
  });
  it("広げた範囲を取るときは、もう取ったタイルを取り直さない(2026-11-12)", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) }));
    const first = await fetchGsiTiles(C, ok);
    const n0 = ok.mock.calls.length;
    const wider = { ex: MAP_EX, ey: 1100 };
    const all = await fetchGsiTiles(C, ok, wider, first);
    expect(all.length).toBe(tilesCovering(C.lng, C.lat, wider.ex, wider.ey).length);
    expect(ok.mock.calls.length - n0).toBe(all.length - first.length);
    expect(first.every((t) => all.includes(t))).toBe(true);
  });
  it("広げた範囲で作ると、その範囲の大きさで切る", () => {
    const tile = makeTile([{ name: "building", features: [{ type: 3, props: { ftCode: 3101 }, parts: [square(0, 0, 20)] }] }]);
    const m = buildMapFromTiles(C, [{ x: TX, y: TY, buf: tile }], new Date(), { extent: { ex: 1000, ey: 950 } });
    expect([m.ex, m.ey]).toEqual([1000, 950]);
  });
  it("それ以外の失敗は全体を失敗にする(欠けた地図を作らない)", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(fetchGsiTiles(C, f)).rejects.toThrow();
  });
});

describe("地図の範囲(2026-11-12 駅・周辺施設が入る大きさ)", () => {
  it("点がなければ基本の大きさ", () => {
    expect(mapExtentFor([])).toEqual({ ex: MAP_EX, ey: MAP_EY });
    expect(mapExtentFor([[100, -200]])).toEqual({ ex: MAP_EX, ey: MAP_EY });
  });
  it("外にある点まで余白付きで広げる(50m 単位)・上限で止める", () => {
    expect(mapExtentFor([[254, 764]])).toEqual({ ex: MAP_EX, ey: 950 });
    expect(mapExtentFor([[-1100, 0]])).toEqual({ ex: 1300, ey: MAP_EY });
    expect(mapExtentFor([[5000, -5000]])).toEqual({ ex: MAP_EX_MAX, ey: MAP_EY_MAX });
    expect(mapExtentFor([[Number.NaN, 9999]])).toEqual({ ex: MAP_EX, ey: MAP_EY });
  });
  it("南北に広く散らばるときは、横長の平面の地図に入るよう東西も広げる", () => {
    // 査定書の施設と、北へ 760m の駅(本番の資料と同じ並び)
    expect(mapExtentFor([[-407, 40], [534, -307], [-357, 382], [-169, -376], [254, 764]])).toEqual({ ex: 1350, ey: 950 });
  });
  it("東西に広く散らばるときは、横長の平面の地図の東西の幅が出せるよう南北も広げる(@codex #718)", () => {
    // deck.js の映す幅は min(ex, ey×1080/620) で頭打ちになる。東西 ±1200 の施設が入る幅(1200×1.35)を出せる南北が要る。
    const e = mapExtentFor([[-1200, 0], [1200, 0]]);
    expect(e).toEqual({ ex: 1600, ey: 950 });
    expect(Math.min(e.ex, (e.ey * 1080) / 620)).toBeGreaterThanOrEqual(1200);
    // 上限の中で、要る東西の幅(上限で頭打ち)をいつも映せる。
    for (const pts of [[[-1500, 10], [1500, -10]], [[-900, 0], [900, 0]], [[0, 0], [1400, 50]]] as Array<Array<[number, number]>>) {
      const x = mapExtentFor(pts);
      const xs = pts.map((p) => p[0]).concat(0);
      const need = Math.min(MAP_EX_MAX, ((Math.max(...xs) - Math.min(...xs)) / 2) * 1.35);
      expect(Math.min(x.ex, (x.ey * 1080) / 620)).toBeGreaterThanOrEqual(need);
    }
  });
  it("範囲の中かどうか(端の近くは外とみなす)", () => {
    expect(insideExtent({ x: 254, y: 764 }, { ex: 1000, ey: 650 })).toBe(false);
    expect(insideExtent({ x: 254, y: 764 }, { ex: 1000, ey: 950 })).toBe(true);
    expect(insideExtent({ x: 0, y: 1260 }, { ex: 1000, ey: 1300 })).toBe(false);
  });
});

describe("isUsableLocation", () => {
  it("日本のあたりの数字だけ", () => {
    expect(isUsableLocation(35.65, 139.7)).toBe(true);
    expect(isUsableLocation(null, 139.7)).toBe(false);
    expect(isUsableLocation(0, 0)).toBe(false);
    expect(isUsableLocation(Number.NaN, 139.7)).toBe(false);
  });
});

describe("最寄り駅までの徒歩ルート(2026-11-11)", () => {
  // 物件から東へ 800 点、そこから南へ 800 点の道。駅はその先。もう1つ別の駅も置く
  const t3 = makeTile([
    {
      name: "road",
      features: [
        { type: 2, props: { ftCode: 2701, rnkWidth: 1 }, parts: [[[PX, PY], [PX + 800, PY]]] },
        { type: 2, props: { ftCode: 2701, rnkWidth: 1 }, parts: [[[PX + 800, PY], [PX + 800, PY + 800]]] },
        { type: 2, props: { ftCode: 2701, rnkWidth: 4, rdCtg: 3 }, parts: [[[PX, PY], [PX + 800, PY + 800]]] }, // 高速の近道(歩けない)
      ],
    },
    {
      name: "label",
      features: [
        { type: 1, props: { knj: "見本駅", ftCode: 100 }, parts: [[[PX + 800, PY + 820]]] },
        { type: 1, props: { knj: "別の駅", ftCode: 100 }, parts: [[[PX + 50, PY + 50]]] },
        { type: 1, props: { knj: "見本町", ftCode: 100 }, parts: [[[PX + 10, PY]]] },
      ],
    },
  ]);
  it("査定書の駅名の駅へ、道に沿った最短の道のり(高速は通らない)", () => {
    const m = buildMapFromTiles(C, [{ x: TX, y: TY, buf: t3 }], new Date(), { station: "見本駅" });
    expect(m.st?.n).toBe("見本駅");
    expect(m.st!.y).toBeLessThan(0); // 南
    expect(m.rt!.length).toBeGreaterThanOrEqual(6);
    // 東へ約 97m + 南へ約 97m(1点 ≒ 0.12m)。斜めの高速(約 137m)は使わない
    expect(m.rtm!).toBeGreaterThan(180);
    expect(m.rtm!).toBeLessThan(215);
  });
  it("駅名が合わなければ一番近い駅・駅がなければルートなし", () => {
    expect(buildMapFromTiles(C, [{ x: TX, y: TY, buf: t3 }], new Date(), { station: "知らない駅" }).st?.n).toBe("別の駅");
    const none = buildMapFromTiles(C, [{ x: TX, y: TY, buf: makeTile([{ name: "road", features: [] }]) }]);
    expect(none.st).toBeUndefined();
    expect(none.rt).toBeUndefined();
  });
});
