import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderAppraisalDeck, buildDeckData, jsonForScript, deckTitle, mapHeadline, RENDER_HEADERS } from "../render";
import type { DeckMapData } from "../map/build";
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
const MAP: DeckMapData = {
  version: 1,
  builtAt: "2026-11-11T00:00:00.000Z",
  ex: 1000,
  ey: 650,
  b: [[8, 0, -20, -20, 40, 0, 0, 40, -40, 0]],
  p: 0,
  r: [[2, 0, -400, 0, 800, 0]],
  w: [],
  v: [],
  t: [],
  bh: [],
  wh: [],
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
    // 補正の項目名「接道状況/方位」だけでは未接道としない(@codex #694)
    expect(isUnconnectedCase(mergeAppraisal({ ...HOUSE, roadAccess: "一方", notes: null }, {}))).toBe(false);
    expect(isUnconnectedCase(mergeAppraisal({ ...HOUSE, roadAccess: null, notes: "未接道地" }, {}))).toBe(true);
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
  it("周辺地図がなければ4ページ・3D の部品は入れない(これまでどおり)", () => {
    const html = renderAppraisalDeck(mergeAppraisal(HOUSE, {}), { draft: false });
    expect(html.match(/<section class="page"/g)).toHaveLength(4);
    expect(html).not.toContain('data-k="map"');
    expect(html).not.toContain('id="deck-map"');
    expect(html).not.toContain("window.THREE=Object.freeze");
    expect(html).toContain("1 / 4");
  });
  it("周辺地図があれば先頭に地図のページ・地図のデータと 3D の部品を埋め込む(外から読まない)", () => {
    const map = { ...MAP, t: [["</script><img src=x>", 0, 0, 2, 2]] };
    const html = renderAppraisalDeck(mergeAppraisal(HOUSE, {}), { draft: false, map });
    expect(html.match(/<section class="page"/g)).toHaveLength(5);
    expect(html.indexOf('data-k="map"')).toBeLessThan(html.indexOf('data-k="result"'));
    expect(html).toContain("1 / 5");
    expect(html).toContain("window.THREE=Object.freeze");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(html).not.toContain("</script><img");
    const data = JSON.parse(/<script id="deck-map" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(data.t[0][0]).toBe("</script><img src=x>");
    // ページの行き先は番号ではなくページの名前(地図のページで番号がずれても行き先が変わらない)
    expect(html).toContain('data-go="basis"');
    expect(html).not.toMatch(/data-go="\d"/);
  });
  it("住所から求めた地図は「位置は目安」と書く(GPS のときは書かない)", () => {
    const m = mergeAppraisal(HOUSE, {});
    expect(renderAppraisalDeck(m, { draft: false, map: { ...MAP, loc: "address" } })).toContain("住所から求めた目安");
    expect(renderAppraisalDeck(m, { draft: false, map: MAP })).not.toContain("住所から求めた目安");
  });
  it("地図のページの見出しは駅と徒歩分数から作る(「駅駅」にしない)・HTML の特殊文字を逃がす", () => {
    expect(mapHeadline(mergeAppraisal(HOUSE, {}))).toBe("東京都架空区見本町4丁目にあり、架空線「見本」駅まで徒歩10分の物件です");
    expect(mapHeadline(mergeAppraisal({ ...HOUSE, station: null }, {}))).toBe("東京都架空区見本町4丁目にある物件の場所と周りの様子です");
    const html = renderAppraisalDeck(mergeAppraisal({ ...HOUSE, area: "東京都<b>区" }, {}), { draft: false, map: MAP });
    expect(html).not.toContain("<b>区");
  });
  it("駅の札の徒歩分: 査定書の駅なら査定書の徒歩分、違う駅ならルートの道のりから(@codex #707)", () => {
    const js = readFileSync(path.join(process.cwd(), "src/lib/appraisal-deck/assets/deck.js"), "utf8");
    const lines = js.split("\n").filter((l) => /^const (stName|stWalk)=/.test(l));
    expect(lines).toHaveLength(2);
    const stWalk = (MAP: unknown, D: unknown) => new Function("MAP", "D", `${lines.join("\n")}\nreturn stWalk();`)(MAP, D) as number;
    const map = { st: { n: "見本駅", x: 0, y: 0 }, rtm: 400 };
    expect(stWalk(map, { station: "見本", walkMinutes: 15 })).toBe(15);
    expect(stWalk({ ...map, st: { n: "別の駅", x: 0, y: 0 } }, { station: "見本駅", walkMinutes: 15 })).toBe(5);
    expect(stWalk(map, { station: "見本駅", walkMinutes: null })).toBe(5);
  });
  it("資料の動き(deck.js)は構文として正しい", () => {
    const js = readFileSync(path.join(process.cwd(), "src/lib/appraisal-deck/assets/deck.js"), "utf8");
    expect(() => new Function(js)).not.toThrow();
  });
});

describe("周辺施設(2026-11-11)", () => {
  const FAC = [
    { cat: "コンビニ", name: "<b>見本店</b>", dist: 100, min: 2, x: 100, y: 0 },
    { cat: "公園", name: "見本公園", dist: 50, min: 1, x: null, y: null },
    { cat: "銀行", name: "外した銀行", dist: 300, min: 4, x: 0, y: 300 },
  ];
  it("地図のページの右に一覧(外したものは出さない・文字は逃がす)・資料のデータにも番号つきで入る", () => {
    const m = mergeAppraisal({ ...HOUSE, facilities: FAC }, { hiddenFacilities: [2] });
    const html = renderAppraisalDeck(m, { draft: false, map: MAP });
    expect(html).toContain('<ol class="facl">');
    expect(html).toContain("&lt;b&gt;見本店&lt;/b&gt;");
    expect(html).not.toContain("外した銀行");
    expect(html).toContain("ナビタイムジャパン");
    const data = JSON.parse(/<script id="deck-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(data.facilities.map((f: { no: number; cat: string }) => [f.no, f.cat])).toEqual([
      [1, "コンビニ"],
      [2, "公園"],
    ]);
  });
  it("施設がなければ一覧は出さず、円の説明を出す", () => {
    const html = renderAppraisalDeck(mergeAppraisal(HOUSE, {}), { draft: false, map: MAP });
    expect(html).not.toContain('class="facl"');
    expect(html).toContain("地図の円は物件からの直線距離");
  });
});
