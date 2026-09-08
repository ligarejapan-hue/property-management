import { describe, it, expect } from "vitest";
import { assignCrossEvenly, assignVariantsEvenly } from "../sale-dm-letter/assign";

const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

// 決定的な擬似乱数(LCG)。同じ seed で新しく作れば、同じ回数呼んだときに同じ列を返す
// (Math.random だと呼び出しごとに状態が続くので使えない)。
function makeLcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function counts(map: Map<string, { variantId: string; lpVariantId: string | null }>) {
  const pair = new Map<string, number>(); const dm = new Map<string, number>(); const lp = new Map<string, number>();
  for (const v of map.values()) {
    const k = `${v.variantId}|${v.lpVariantId}`;
    pair.set(k, (pair.get(k) ?? 0) + 1);
    dm.set(v.variantId, (dm.get(v.variantId) ?? 0) + 1);
    lp.set(String(v.lpVariantId), (lp.get(String(v.lpVariantId)) ?? 0) + 1);
  }
  return { pair, dm, lp };
}
const spread = (m: Map<string, number>, expectedKeys: number) => {
  const vals = [...m.values()];
  while (vals.length < expectedKeys) vals.push(0);
  return Math.max(...vals) - Math.min(...vals);
};

describe("assignCrossEvenly(総当たり)", () => {
  it("LP型が0件なら既存の assignVariantsEvenly と完全一致(後方互換)・lpVariantId は null", () => {
    for (let n = 1; n <= 4; n++) for (let r = 0; r <= 12; r++) {
      const dm = ids("d", n); const rec = ids("r", r);
      const cross = assignCrossEvenly(rec, dm, []);
      const legacy = assignVariantsEvenly(rec, dm);
      expect(cross.size).toBe(legacy.size);
      for (const [rid, vid] of legacy) expect(cross.get(rid)).toEqual({ variantId: vid, lpVariantId: null });
    }
  });
  it("DM型×LP型の全組が最大1差で均等、DM型の周辺も既存と同じ順、LP型の周辺は最大2差", () => {
    for (let n = 1; n <= 4; n++) for (let m = 1; m <= 4; m++) for (let r = 0; r <= 40; r++) {
      const dm = ids("d", n); const lp = ids("l", m); const rec = ids("r", r);
      const map = assignCrossEvenly(rec, dm, lp);
      expect(map.size).toBe(r);
      const c = counts(map);
      expect(spread(c.pair, n * m), `n=${n} m=${m} r=${r}`).toBeLessThanOrEqual(1);
      expect(spread(c.dm, n)).toBeLessThanOrEqual(1);
      expect(spread(c.lp, m)).toBeLessThanOrEqual(2);
      const legacy = assignVariantsEvenly(rec, dm);
      for (const [rid, vid] of legacy) expect(map.get(rid)?.variantId).toBe(vid);
      for (const v of map.values()) expect(lp).toContain(v.lpVariantId);
    }
  });
  it("端数は先頭の組から1つずつ多い(sequential・n=2 m=2 r=5)", () => {
    const map = assignCrossEvenly(ids("r", 5), ids("d", 2), ids("l", 2));
    expect([...map.values()]).toEqual([
      { variantId: "d0", lpVariantId: "l0" }, { variantId: "d1", lpVariantId: "l1" },
      { variantId: "d0", lpVariantId: "l1" }, { variantId: "d1", lpVariantId: "l0" },
      { variantId: "d0", lpVariantId: "l0" },
    ]);
  });
  it("random は本数分布を変えず並びだけ変える(rng 注入)", () => {
    const rec = ids("r", 9);
    const a = assignCrossEvenly(rec, ids("d", 2), ids("l", 2));
    const b = assignCrossEvenly(rec, ids("d", 2), ids("l", 2), { order: "random", rng: () => 0 });
    expect(counts(a).pair).toEqual(counts(b).pair);
    expect([...a.values()]).not.toEqual([...b.values()]);
  });
  it("random でも DM軸は assignVariantsEvenly と宛先ごとに一致する(同じ rng 列を注入)", () => {
    for (let n = 1; n <= 3; n++) for (let r = 0; r <= 12; r++) {
      const dm = ids("d", n); const rec = ids("r", r);
      // shuffle が消費する呼び出し回数は recipientIds の長さで決まるため、両方に
      // 同じ seed で新しく作った LCG を渡せば同じ並びを再現できる。
      const cross = assignCrossEvenly(rec, dm, [], { order: "random", rng: makeLcg(7) });
      const legacy = assignVariantsEvenly(rec, dm, { order: "random", rng: makeLcg(7) });
      expect(cross.size).toBe(legacy.size);
      for (const rid of rec) {
        expect(cross.get(rid)?.variantId, `n=${n} r=${r} rid=${rid}`).toBe(legacy.get(rid));
      }
    }
  });
  it("DM型か宛先が空なら空 Map", () => {
    expect(assignCrossEvenly([], ids("d", 2), ids("l", 2)).size).toBe(0);
    expect(assignCrossEvenly(ids("r", 3), [], ids("l", 2)).size).toBe(0);
  });
});
