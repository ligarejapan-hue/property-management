import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderAppraisalDeck, buildDeckData, jsonForScript, deckTitle, RENDER_HEADERS } from "../render";
import { defaultHeadlines, isUnconnectedCase } from "../headlines";
import { mergeAppraisal } from "../overrides";
import type { AppraisalExtract } from "../parse";

const HOUSE: AppraisalExtract = {
  parserVersion: 1,
  source: "sre",
  kind: "house",
  appraisedOn: "2026-08-24",
  area: "東京都架空区見本町4丁目",
  railLine: "架空線",
  station: "見本駅",
  walkMinutes: 10,
  landSqm: 45.59,
  landTsubo: 13.79,
  floorSqm: 64.32,
  exclusiveSqm: null,
  builtYearMonth: "1996-11",
  structure: "木造(W)",
  layout: null,
  floorInfo: null,
  roadAccess: "接道なし",
  roadDetail: null,
  notes: "未接道地",
  expected: { total: 1304, tsubo: null, land: 1214, landTsubo: 88, building: 90, buildingTsubo: 4.6 },
  ai: { total: 4137, tsubo: null, land: 4047, landTsubo: 293.5, building: 90, buildingTsubo: 4.6 },
  adjustment: { landPercent: -70, landAmount: null, landReason: "接道状況/方位", liquidityPercent: 0, items: [] },
  plans: [
    { name: "speed", price: 1080, tsubo: null },
    { name: "standard", price: 1280, tsubo: null },
    { name: "challenge", price: 1480, tsubo: null },
  ],
  range: null,
  warnings: [],
};
const LAND: AppraisalExtract = {
  ...HOUSE,
  kind: "land",
  floorSqm: null,
  roadAccess: "一方",
  notes: null,
  expected: { total: 6114, tsubo: 479.3, land: null, landTsubo: null, building: null, buildingTsubo: null },
  ai: { total: 5823, tsubo: 456.5, land: null, landTsubo: null, building: null, buildingTsubo: null },
  adjustment: { landPercent: null, landAmount: 0, landReason: "土地形状", liquidityPercent: 5, items: [] },
  plans: [],
  range: { min: 6280, max: 6580, minTsubo: 492.3, maxTsubo: 515.8 },
};

describe("見出しの既定の文", () => {
  it("戸建(3案・補正あり)", () => {
    const h = defaultHeadlines(mergeAppraisal(HOUSE, {}));
    expect(h.result).toBe("ご所有の戸建の成約想定価格を1,304万円と査定し、売出しは1,080〜1,480万円の3案をご提案します");
    expect(h.basis).toContain("土地の評価の補正（−70%）");
    expect(h.plans).toContain("3案の価格差は400万円");
  });
  it("土地(価格の幅・補正なし)", () => {
    const h = defaultHeadlines(mergeAppraisal(LAND, {}));
    expect(h.result).toContain("6,280〜6,580万円の価格帯");
    expect(h.basis).toContain("物件の評価を反映した6,114万円");
  });
  it("未接道の図は、土地の補正がマイナスで接道の記載があるときだけ", () => {
    expect(isUnconnectedCase(mergeAppraisal(HOUSE, {}))).toBe(true);
    expect(isUnconnectedCase(mergeAppraisal(LAND, {}))).toBe(false);
    expect(isUnconnectedCase(mergeAppraisal({ ...HOUSE, roadAccess: "一方", notes: null, adjustment: { ...HOUSE.adjustment, landReason: "土地形状" } }, {}))).toBe(false);
  });
});

describe("renderAppraisalDeck(資料の HTML)", () => {
  it("担当者の見出しは JSON に入れ、HTML として解釈されない形にする", () => {
    const evil = '</script><img src=x onerror="alert(1)">';
    const html = renderAppraisalDeck(mergeAppraisal(HOUSE, { headlines: { result: evil } }), { draft: false });
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("<img src=x");
    const data = JSON.parse(/<script id="deck-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(data.headlines.result).toBe(evil);
  });
  it("外のファイル・通信を使わない(1つのファイルで完結)", () => {
    const html = renderAppraisalDeck(mergeAppraisal(HOUSE, {}), { draft: false });
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(RENDER_HEADERS["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(RENDER_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
  });
  it("所在地(町丁目)より細かい情報や氏名の口を持たない", () => {
    const data = buildDeckData(mergeAppraisal(HOUSE, {}), { draft: true });
    expect(Object.keys(data)).not.toEqual(expect.arrayContaining(["owner", "ownerName", "address"]));
    expect(data.area).toBe("東京都架空区見本町4丁目");
    expect(data.draft).toBe(true);
    expect(data.unconnected).toBe(true);
    expect(data.headlineFundCustom).toBe(false);
  });
  it("書いた見出しはそのまま・空なら既定の文", () => {
    const data = buildDeckData(mergeAppraisal(HOUSE, { headlines: { basis: "  根拠の見出し  ", fund: "" } }), { draft: false });
    expect(data.headlines.basis).toBe("根拠の見出し");
    expect(data.headlines.fund).toBe(defaultHeadlines(mergeAppraisal(HOUSE, {})).fund);
  });
  it("題名は都道府県を外す・HTML の特殊文字を逃がす", () => {
    expect(deckTitle(mergeAppraisal(HOUSE, {}))).toBe("架空区見本町4丁目 査定のご報告");
    const html = renderAppraisalDeck(mergeAppraisal({ ...HOUSE, area: "東京都<b>区" }, {}), { draft: false });
    expect(html).toContain("<title>&lt;b&gt;区 査定のご報告</title>");
  });
  it("jsonForScript は < > & と行区切りを逃がす", () => {
    expect(jsonForScript({ a: "<>& " })).toBe('{"a":"\\u003c\\u003e\\u0026\\u2028"}');
  });
  it("資料の動き(deck.js)は構文として正しい", () => {
    const js = readFileSync(path.join(process.cwd(), "src/lib/appraisal-deck/assets/deck.js"), "utf8");
    expect(() => new Function(js)).not.toThrow();
  });
});
