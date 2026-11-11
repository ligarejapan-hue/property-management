/**
 * 周辺地図のデータ作り(2026-11-11)。本物のタイルは使わず、ベクトルタイルをテストの中で組み立てて確かめる。
 */
import { describe, it, expect, vi } from "vitest";
import { PbfWriter } from "pbf";
import { buildMapFromTiles, chainRings, fetchGsiTiles, isUsableLocation, MAX_TILES, MAP_EX, MAP_EY } from "../map/build";
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
    const rest = f.type === 3 ? part.slice(1) : part.slice(1);
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
  it("それ以外の失敗は全体を失敗にする(欠けた地図を作らない)", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(fetchGsiTiles(C, f)).rejects.toThrow();
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
