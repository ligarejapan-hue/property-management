import { describe, it, expect } from "vitest";
import { parseCompleted, parseFloors, parseUnits, cleanText, toCatalogRow } from "@/lib/mansion-catalog/parse";
import { areaKey, buildingNameKey } from "@/lib/building-identity";

// 実データ(2026-10-17 東京 26,640件)で見た形をそのまま使う。
const LINE = JSON.stringify({
  pref: "13", page: 1, fetchedAt: "2026-10-17T02:28:52.096Z", id: "2093122", name: "プラウド青砥",
  address: "東京都葛飾区青戸4丁目2番14号", stations: ["お花茶屋駅より 徒歩10分", "青砥駅より 徒歩13分"],
  completed: "2026年9月", structure: "RC（鉄筋コンクリート）", floors: "地上14階建", units: "155戸",
  developer: "野村不動産", manager: "野村不動産パートナーズ",
});

describe("文字を数字に", () => {
  it("竣工年月", () => {
    expect(parseCompleted("2026年9月")).toEqual({ year: 2026, month: 9 });
    expect(parseCompleted("１９７８年５月")).toEqual({ year: 1978, month: 5 });
    expect(parseCompleted("1978年")).toEqual({ year: 1978, month: null });
    expect(parseCompleted("不明")).toBeNull();
    expect(parseCompleted("2026年13月")).toEqual({ year: 2026, month: null });
    expect(parseCompleted(null)).toBeNull();
  });
  it("階建(地上・地下)", () => {
    expect(parseFloors("地上14階建")).toEqual({ above: 14, below: null });
    expect(parseFloors("地上10階建 地下1階")).toEqual({ above: 10, below: 1 });
    expect(parseFloors("地上１０階建　地下２階")).toEqual({ above: 10, below: 2 });
    expect(parseFloors("不明")).toEqual({ above: null, below: null });
    expect(parseFloors(null)).toEqual({ above: null, below: null });
  });
  it("総戸数", () => {
    expect(parseUnits("155戸")).toBe(155);
    expect(parseUnits("１，２００戸")).toBe(1200);
    expect(parseUnits("総戸数不明")).toBeNull();
    expect(parseUnits("0戸")).toBeNull();
  });
  it("不明・空は null", () => {
    expect(cleanText("不明")).toBeNull();
    expect(cleanText("  ")).toBeNull();
    expect(cleanText(3)).toBeNull();
    expect(cleanText(" 野村不動産 ")).toBe("野村不動産");
  });
});

describe("toCatalogRow", () => {
  it("1行を名簿の行にする(比べる形も入れる・取ったままも raw に残す)", () => {
    const r = toCatalogRow(LINE)!;
    expect(r).toMatchObject({
      source: "selfin", sourceId: "2093122", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号",
      prefCode: "13", builtYear: 2026, builtMonth: 9, totalFloors: 14, basementFloors: null, totalUnits: 155,
      structureType: "RC（鉄筋コンクリート）", developer: "野村不動産", managementCompany: "野村不動産パートナーズ",
      nameKey: buildingNameKey("プラウド青砥"), areaKey: areaKey("東京都葛飾区青戸4丁目2番14号"),
    });
    expect(r.stations).toEqual(["お花茶屋駅より 徒歩10分", "青砥駅より 徒歩13分"]);
    expect(r.fetchedAt.toISOString()).toBe("2026-10-17T02:28:52.096Z");
    expect(r.raw).toMatchObject({ floors: "地上14階建", units: "155戸" });
  });
  it("★壊れた行・番号/名前/住所の無い行は null(読み込みで飛ばして数える)", () => {
    expect(toCatalogRow("{")).toBeNull();
    expect(toCatalogRow("")).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), name: "" }))).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), address: null }))).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), id: "abc" }))).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), pref: "99" }))).toBeNull();
  });
  it("★構造「不明」・取った時刻が読めないときも、他の欄は入れる", () => {
    const r = toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), structure: "不明", fetchedAt: "x", stations: "x" }))!;
    expect(r.structureType).toBeNull();
    expect(r.stations).toEqual([]);
    expect(Number.isNaN(r.fetchedAt.getTime())).toBe(false);
    expect(r.totalUnits).toBe(155);
  });
});
