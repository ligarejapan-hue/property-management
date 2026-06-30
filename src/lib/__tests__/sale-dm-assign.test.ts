import { describe, it, expect } from "vitest";
import { assignVariantsEvenly, applyManualAssignment } from "../sale-dm-letter/assign";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i + 1}`);

function countByVariant(map: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of map.values()) out[v] = (out[v] ?? 0) + 1;
  return out;
}

describe("assignVariantsEvenly (sequential)", () => {
  it("割り切れるときは完全均等", () => {
    const map = assignVariantsEvenly(ids(4), ["A", "B"], { order: "sequential" });
    expect(map.size).toBe(4);
    expect(countByVariant(map)).toEqual({ A: 2, B: 2 });
  });

  it("端数は先頭の型から1つずつ多く(ラウンドロビン)", () => {
    const map = assignVariantsEvenly(ids(5), ["A", "B"], { order: "sequential" });
    expect(map.get("r1")).toBe("A");
    expect(map.get("r2")).toBe("B");
    expect(map.get("r3")).toBe("A");
    expect(map.get("r4")).toBe("B");
    expect(map.get("r5")).toBe("A");
    expect(countByVariant(map)).toEqual({ A: 3, B: 2 });
  });

  it("3型7人でも各型の差は最大1", () => {
    const map = assignVariantsEvenly(ids(7), ["A", "B", "C"], { order: "sequential" });
    const counts = Object.values(countByVariant(map));
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(map.size).toBe(7);
  });
});

describe("assignVariantsEvenly (random)", () => {
  it("rng 注入で決定的・分布は sequential と同じ(均等)", () => {
    // rng=()=>0 は Fisher-Yates で各位置を先頭要素と入れ替える(決定的)
    const map = assignVariantsEvenly(ids(5), ["A", "B"], { order: "random", rng: () => 0 });
    expect(map.size).toBe(5);
    expect(countByVariant(map)).toEqual({ A: 3, B: 2 }); // 並びは違っても本数は均等
  });
});

describe("空入力", () => {
  it("型が空なら空 Map", () => {
    expect(assignVariantsEvenly(ids(3), []).size).toBe(0);
  });
  it("宛先が空なら空 Map", () => {
    expect(assignVariantsEvenly([], ["A", "B"]).size).toBe(0);
  });
});

describe("applyManualAssignment", () => {
  it("指定された宛先だけを割り当て・未指定は Map に含めない(現状の型を維持=再割当しない)", () => {
    const map = applyManualAssignment(ids(3), ["A", "B"], [{ recipientId: "r2", variantId: "B" }]);
    expect(map.get("r2")).toBe("B");
    expect(map.size).toBe(1);
    // 手動指定外の r1/r3 は Map に含めない(route は触らない=既存の A/B バケットを保全)。
    expect(map.has("r1")).toBe(false);
    expect(map.has("r3")).toBe(false);
  });

  it("複数指定はすべて反映し、未指定は含めない", () => {
    const map = applyManualAssignment(ids(4), ["A", "B"], [
      { recipientId: "r1", variantId: "B" },
      { recipientId: "r3", variantId: "A" },
    ]);
    expect(map.get("r1")).toBe("B");
    expect(map.get("r3")).toBe("A");
    expect(map.size).toBe(2);
  });

  it("対象 recipientIds に無い id の指定は無視する(空 Map)", () => {
    const map = applyManualAssignment(ids(2), ["A", "B"], [{ recipientId: "zzz", variantId: "A" }]);
    expect(map.has("zzz")).toBe(false);
    expect(map.size).toBe(0);
  });

  it("対象 variantIds に無い variant の指定は無視する(その宛先は Map に含めない)", () => {
    const map = applyManualAssignment(ids(2), ["A", "B"], [{ recipientId: "r1", variantId: "ZZZ" }]);
    expect(map.has("r1")).toBe(false);
    expect(map.size).toBe(0);
  });
});
