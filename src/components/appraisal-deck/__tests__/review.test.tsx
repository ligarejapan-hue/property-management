import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOverrides, parseNum } from "../AppraisalDeckReview";
import { AppraisalDeckCardView, formatAppraisedOn } from "../AppraisalDeckCard";
import type { AppraisalExtract } from "@/lib/appraisal-deck/parse";

const EX = {
  area: "東京都架空区見本町4丁目",
  station: "見本駅",
  walkMinutes: 10,
  landSqm: 45.59,
  landTsubo: 13.79,
  expected: { total: 1304, tsubo: null, land: 1214, landTsubo: 88, building: 90, buildingTsubo: 4.6 },
  ai: { total: 4137, tsubo: null, land: 4047, landTsubo: 293.5, building: 90, buildingTsubo: 4.6 },
  adjustment: { landPercent: -70, landAmount: null, landReason: null, liquidityPercent: 0, items: [] },
  plans: [
    { name: "speed", price: 1080, tsubo: null },
    { name: "standard", price: 1030, tsubo: null },
    { name: "challenge", price: 1480, tsubo: null },
  ],
  range: null,
} as unknown as AppraisalExtract;

const FORM = {
  area: "東京都架空区見本町4丁目",
  station: "見本駅",
  walkMinutes: "10",
  landSqm: "45.59",
  landTsubo: "13.79",
  "expected.total": "1,304",
  "expected.land": "1,214",
  "expected.landTsubo": "88",
  "expected.building": "90",
  "expected.tsubo": "",
  "expected.buildingTsubo": "4.6",
  "ai.total": "4,137",
  "ai.land": "4,047",
  "ai.landTsubo": "293.5",
  "ai.building": "90",
  "ai.tsubo": "",
  "ai.buildingTsubo": "4.6",
  "adjustment.landAmount": "",
  "adjustment.landPercent": "-70",
  "adjustment.liquidityPercent": "0",
  "plan.speed": "1,080",
  "plan.standard": "1,030",
  "plan.challenge": "1,480",
};

describe("parseNum", () => {
  it.each([
    ["1,304", 1304],
    ["１３０４", 1304],
    ["−70", -70],
    ["293.5", 293.5],
    ["", null],
  ])("%s → %s", (s, n) => expect(parseNum(s)).toBe(n));
  it("数字でなければ NaN", () => expect(parseNum("abc")).toBeNaN());
});

describe("buildOverrides(読み取り値と違う項目だけ送る)", () => {
  it("何も直していなければ空", () => {
    expect(buildOverrides(FORM, EX, false)).toEqual({ overrides: {}, errors: [] });
  });
  it("直した数字・3案・見出しだけ入る", () => {
    const r = buildOverrides({ ...FORM, "expected.total": "1,350", "plan.standard": "1,280", "h.result": " 見出し " }, EX, false);
    expect(r.errors).toEqual([]);
    expect(r.overrides).toEqual({
      expected: { total: 1350 },
      plans: [
        { name: "speed", price: 1080, tsubo: null },
        { name: "standard", price: 1280, tsubo: null },
        { name: "challenge", price: 1480, tsubo: null },
      ],
      headlines: { result: "見出し" },
    });
  });
  it("画面に欄の無い修正(建物の坪単価・土地の評価の金額)も保存のたびに消さない(@codex #694)", () => {
    const r = buildOverrides({ ...FORM, "expected.buildingTsubo": "5", "adjustment.landAmount": "-100", "expected.total": "1,350" }, EX, false);
    expect(r.overrides).toEqual({ expected: { total: 1350, buildingTsubo: 5 }, adjustment: { landAmount: -100 } });
  });

  it("数字でない欄はエラーにして送らない", () => {
    const r = buildOverrides({ ...FORM, "ai.total": "よんせん" }, EX, false);
    expect(r.errors[0]).toContain("AI査定価格の総額");
  });
  it("価格の幅は下限と上限の両方が要る", () => {
    const r = buildOverrides({ ...FORM, "range.min": "6,280", "range.max": "" }, { ...EX, plans: [] } as AppraisalExtract, true);
    expect(r.errors).toContain("価格の幅は下限と上限の両方を入れてください");
  });
});

describe("物件ページのカード", () => {
  it("0件なら何も出さない", () => {
    expect(renderToStaticMarkup(<AppraisalDeckCardView propertyId="p1" decks={[]} />)).toBe("");
  });
  it("確認待ちは「確認する」、確認済みは「資料を見る」「ダウンロード」", () => {
    const html = renderToStaticMarkup(
      <AppraisalDeckCardView
        propertyId="p1"
        decks={[
          { id: "d1", status: "draft", kind: "house", appraisedOn: "2026-08-24", warningCount: 1, confirmedAt: null },
          { id: "d2", status: "confirmed", kind: "house", appraisedOn: "2026-03-20", warningCount: 0, confirmedAt: "2026-11-02T00:00:00Z" },
        ]}
      />,
    );
    expect(html).toContain("確認待ち");
    expect(html).toContain("注意 1件");
    expect(html).toContain('href="/properties/p1/appraisal-decks/d1"');
    expect(html).toContain('href="/api/properties/p1/appraisal-decks/d2/view?download=1"');
    expect(html).toContain("確認済み");
    expect(html).not.toContain('appraisal-decks/d1/view?download=1');
  });
  it("査定日の表記", () => {
    expect(formatAppraisedOn("2026-08-24")).toBe("2026年8月24日の査定");
    expect(formatAppraisedOn(null)).toBe("査定日の記載なし");
  });
});

describe("載せない周辺施設(2026-11-11)", () => {
  const EXF = { ...EX, facilities: [{ cat: "コンビニ", name: "a", dist: 1, min: 1, x: 1, y: 1 }, { cat: "公園", name: "b", dist: 1, min: 1, x: null, y: null }] } as unknown as AppraisalExtract;
  it("外した番号だけ送る(範囲外の番号は捨てる)・外していなければ送らない", () => {
    expect(buildOverrides({ ...FORM, "fac.hidden": "1,7" }, EXF, false).overrides.hiddenFacilities).toEqual([1]);
    expect(buildOverrides({ ...FORM, "fac.hidden": "" }, EXF, false).overrides.hiddenFacilities).toBeUndefined();
  });
});

describe("確認の取り消し(2026-11-12・@codex #711)", () => {
  it("保存前の直しがあるときは取り消さない(取り消し後の読み直しで直しが消えるため)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../AppraisalDeckReview.tsx"), "utf8").replace(/\r\n/g, "\n");
    const start = src.indexOf("const unconfirm = async () => {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  };", start));
    const guard = body.indexOf("if (dirty)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('method: "DELETE"'));
    expect(guard).toBeLessThan(body.indexOf("window.confirm"));
  });
});
