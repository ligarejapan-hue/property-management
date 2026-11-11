/**
 * 最寄り駅までの徒歩ルート(目安・2026-11-11)。
 */
import { describe, it, expect } from "vitest";
import { normalizeStationName, pickStation, shortestWalk } from "../map/route";

describe("pickStation", () => {
  const S = [
    { name: "武蔵小山駅", x: 600, y: -300 },
    { name: "西小山駅", x: 13, y: -249 },
    { name: "遠い駅", x: 5000, y: 0 },
  ];
  it("査定書の駅名に合う駅を選ぶ(「駅」の有無・全角半角は問わない)", () => {
    expect(pickStation(S, "西小山")?.name).toBe("西小山駅");
    expect(pickStation(S, "武蔵小山駅")?.name).toBe("武蔵小山駅");
    expect(normalizeStationName(" 西小山駅 ")).toBe("西小山");
  });
  it("合う駅がなければ一番近い駅・遠すぎる駅は選ばない", () => {
    expect(pickStation(S, "存在しない")?.name).toBe("西小山駅");
    expect(pickStation([{ name: "遠い駅", x: 5000, y: 0 }], null)).toBeNull();
  });
});

describe("shortestWalk", () => {
  // 格子の道(100m 間隔)。斜めの近道はない。
  const grid: Array<Array<[number, number]>> = [];
  for (let i = -2; i <= 2; i++) {
    grid.push([
      [i * 100, -200],
      [i * 100, 200],
    ]);
    grid.push([
      [-200, i * 100],
      [200, i * 100],
    ]);
  }
  // 交差点で点を分けた形にする(地理院の道路は交差点で切れている)
  const split = grid.flatMap((l) => {
    const [[x1, y1], [x2, y2]] = l;
    const out: Array<Array<[number, number]>> = [];
    for (let k = 0; k < 4; k++) {
      const a: [number, number] = [x1 + ((x2 - x1) * k) / 4, y1 + ((y2 - y1) * k) / 4];
      const b: [number, number] = [x1 + ((x2 - x1) * (k + 1)) / 4, y1 + ((y2 - y1) * (k + 1)) / 4];
      out.push([a, b]);
    }
    return out;
  });
  it("道に沿った最短の道のり(格子なら東西と南北の和)", () => {
    const r = shortestWalk(split, [0, 0], [200, -200]);
    expect(r?.meters).toBe(400);
    expect(r?.path[0]).toEqual([0, 0]);
    expect(r?.path[r.path.length - 1]).toEqual([200, -200]);
  });
  it("タイルの境目で 3m 以内にずれた線はつながっているとみなす", () => {
    const r = shortestWalk(
      [
        [
          [0, 0],
          [100, 0],
        ],
        [
          [101.5, 1],
          [200, 0],
        ],
      ],
      [0, 0],
      [200, 0],
    );
    expect(r).not.toBeNull();
  });
  it("つながっていない・道から遠すぎるときは null", () => {
    expect(
      shortestWalk(
        [
          [
            [0, 0],
            [100, 0],
          ],
          [
            [300, 0],
            [400, 0],
          ],
        ],
        [0, 0],
        [400, 0],
      ),
    ).toBeNull();
    expect(shortestWalk(split, [0, 0], [900, 900])).toBeNull();
  });
});
