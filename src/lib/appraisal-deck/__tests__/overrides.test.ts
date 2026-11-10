import { describe, it, expect } from "vitest";
import { appraisalOverridesSchema, mergeAppraisal } from "../overrides";
import type { AppraisalExtract } from "../parse";

const BASE: AppraisalExtract = {
  parserVersion: 1,
  source: "sre",
  kind: "house",
  appraisedOn: "2026-08-24",
  area: "東京都架空区見本町4丁目",
  railLine: null,
  station: "見本駅",
  walkMinutes: 10,
  landSqm: 45.59,
  landTsubo: 13.79,
  floorSqm: 64.32,
  exclusiveSqm: null,
  builtYearMonth: "1996-11",
  structure: null,
  layout: null,
  floorInfo: null,
  roadAccess: "接道なし",
  roadDetail: null,
  notes: null,
  expected: { total: 1304, tsubo: null, land: 1214, landTsubo: 88, building: 90, buildingTsubo: 4.6 },
  ai: { total: 4137, tsubo: null, land: 4047, landTsubo: 293.5, building: 90, buildingTsubo: 4.6 },
  adjustment: { landPercent: -70, landAmount: null, landReason: "接道状況/方位", liquidityPercent: 0, items: [] },
  plans: [{ name: "standard", price: 1280, tsubo: null }],
  range: null,
  warnings: [],
};

describe("appraisalOverridesSchema(担当者が直せる項目)", () => {
  it("知らない項目は受け付けない(依頼者名などを入れる口を作らない)", () => {
    expect(appraisalOverridesSchema.safeParse({ ownerName: "山田" }).success).toBe(false);
    expect(appraisalOverridesSchema.safeParse({ expected: { memo: "x" } }).success).toBe(false);
  });
  it("所在地は町丁目までに切る", () => {
    const r = appraisalOverridesSchema.parse({ area: "東京都架空区見本町4丁目26-8 サンプルビル" });
    expect(r.area).toBe("東京都架空区見本町4丁目");
  });
  it("同じ案が2つ・下限が上限より大きい幅・負の金額は受け付けない", () => {
    expect(
      appraisalOverridesSchema.safeParse({
        plans: [
          { name: "speed", price: 1, tsubo: null },
          { name: "speed", price: 2, tsubo: null },
        ],
      }).success,
    ).toBe(false);
    expect(appraisalOverridesSchema.safeParse({ range: { min: 10, max: 5, minTsubo: null, maxTsubo: null } }).success).toBe(false);
    expect(appraisalOverridesSchema.safeParse({ expected: { total: -1 } }).success).toBe(false);
  });
  it("見出しは120文字まで", () => {
    expect(appraisalOverridesSchema.safeParse({ headlines: { result: "あ".repeat(121) } }).success).toBe(false);
    expect(appraisalOverridesSchema.safeParse({ headlines: { result: "あ".repeat(120) } }).success).toBe(true);
  });
});

describe("mergeAppraisal", () => {
  it("読み取った数字に修正を重ねる(直した項目だけ変わる)", () => {
    const m = mergeAppraisal(BASE, {
      expected: { total: 1350 },
      plans: [{ name: "speed", price: 1100, tsubo: null }],
      headlines: { result: "見出し" },
    });
    expect(m.expected).toEqual({ ...BASE.expected, total: 1350 });
    expect(m.ai).toEqual(BASE.ai);
    expect(m.plans).toEqual([{ name: "speed", price: 1100, tsubo: null }]);
    expect(m.headlines).toEqual({ result: "見出し" });
    expect(m.area).toBe(BASE.area);
  });
});
