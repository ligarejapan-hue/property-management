import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma";
import { buildWriteback } from "../build-writeback";

const emptyCurrent = { property: {}, building: null };

describe("buildWriteback — 土地", () => {
  it("価格・交通・土地面積・計測方式を物件へ", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "3480", access: "○○線 徒歩8分", landArea: "125.30", areaMethod: "実測" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({
      salePrice: 3480,
      access: "○○線 徒歩8分",
      landArea: 125.3,
      landAreaMethod: "実測",
    });
    expect(r.building).toEqual({});
    expect(r.unreadable).toEqual([]);
  });

  it("今の値と同じ欄は入れない", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "3480", access: "○○線 徒歩8分" },
      current: { property: { salePrice: 3480, access: "○○線 徒歩8分" }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("空欄は変更なし(消さない)", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "", access: "   " },
      current: { property: { salePrice: 3480 }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("読み取れない値は保存せずラベルを返す", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "応談", areaMethod: "だいたい" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["価格", "面積計測方式"]);
  });

  it("Decimal の値は正しく比較される(125.30 と 125.3 は同じ)", () => {
    const r = buildWriteback({
      kind: "land",
      values: { landArea: "125.30" },
      current: { property: { landArea: new Prisma.Decimal("125.30") }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("Decimal の値が実際に異なる場合は保存される", () => {
    const r = buildWriteback({
      kind: "land",
      values: { landArea: "126" },
      current: { property: { landArea: new Prisma.Decimal("125.30") }, building: null },
    });
    expect(r.property).toEqual({ landArea: 126 });
  });
});

describe("buildWriteback — 戸建", () => {
  it("築年月は年と月に分ける", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "平成20年3月", structure: "木造", aboveFloors: "2", parking: "有" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({
      builtYear: 2008,
      builtMonth: 3,
      structureType: "木造",
      aboveFloors: 2,
      parking: "有",
    });
  });

  it("読み取れない築年月は保存しない", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "築15年" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["築年月"]);
  });

  it("年だけ読めて月が読めない場合、月は保存しない", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "平成20年" },
      current: { property: { builtYear: 2007, builtMonth: 5 }, building: null },
    });
    expect(r.property).toEqual({ builtYear: 2008 });
  });

  it("年だけ読めて月が読めない場合、年が同じなら保存なし", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "平成20年" },
      current: { property: { builtYear: 2008, builtMonth: 5 }, building: null },
    });
    expect(r.property).toEqual({});
  });
});

describe("buildWriteback — 数値の範囲/整数制約(I-1)", () => {
  // 仕様書 §6.1: 読み取れない値はその欄だけ保存しない。列の制約(validators.tsの
  // updatePropertySchemaと同じ値)を満たさない値も同じ扱いにする(範囲外の値でPrisma/
  // Postgresへ書き込んで例外→トランザクション巻き戻り→図面ごと作成失敗、を防ぐ)。
  it("土地面積が範囲外(DECIMAL(10,2)の桁を超える)なら保存せずラベルを返す", () => {
    const r = buildWriteback({
      kind: "land",
      values: { landArea: "1000000000" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["土地面積"]);
  });

  it("地上階が非整数(3.5)なら保存せずラベルを返す(戸建)", () => {
    const r = buildWriteback({
      kind: "house",
      values: { aboveFloors: "3.5" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["地上階"]);
  });

  it("地上階が範囲外(201)なら保存せずラベルを返す(一棟)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { aboveFloors: "201" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["地上階"]);
  });

  it("地下階が範囲外(21)なら保存せずラベルを返す(戸建)", () => {
    const r = buildWriteback({
      kind: "house",
      values: { basementFloors: "21" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["地下階"]);
  });

  it("管理費が範囲外(10000001)なら保存せずラベルを返す(区分)", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { managementFee: "10000001" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["管理費"]);
  });

  it("所在階が範囲外(-11)なら保存せずラベルを返す(区分)", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { floorNo: "-11" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["所在階"]);
  });

  it("総戸数が範囲外(10000)なら保存せずラベルを返す(一棟)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { totalUnits: "10000" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["総戸数"]);
  });

  it("想定利回りが範囲外(1000)なら保存せずラベルを返す(一棟)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { grossYield: "1000" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["想定利回り"]);
  });

  it("満室想定収入が範囲外(100000000000)なら保存せずラベルを返す(一棟)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { expectedIncome: "100000000000" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["満室想定収入"]);
  });

  it("専有面積・バルコニー面積が範囲外(1000000)なら保存せずラベルを返す(区分)", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { exclusiveArea: "1000000", balconyArea: "1000000" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["専有面積", "バルコニー面積"]);
  });

  it("築年(1799年)は範囲外(1800〜2200)のため保存せずラベルを返す", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "1799年5月" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["築年月"]);
  });

  it("範囲内の値は従来どおり保存される(回帰防止)", () => {
    const r = buildWriteback({
      kind: "house",
      values: { aboveFloors: "2", basementFloors: "1", builtYearMonth: "2010年5月" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({ aboveFloors: 2, basementFloors: 1, builtYear: 2010, builtMonth: 5 });
    expect(r.unreadable).toEqual([]);
  });
});

describe("buildWriteback — 区分マンション", () => {
  // ⚠structure/totalFloors/totalUnits(to: building)は mansionOverridesSchema
  // (src/app/api/properties/[id]/sales-sheets/new/route.ts)に対応するキーが無いため、
  // 本番の入力経路(作成ダイアログ→route.ts)からはこの3キーは到達しない(building.
  // structureType/totalFloors/totalUnits は棟の値が正で図面からは変更できない・
  // 意図的な設計)。このテストは buildWriteback 自体の仕分けロジックを直接固定する
  // 目的で残す(到達不能であることは route レベルのテスト参照)。
  it("部屋の欄は物件・棟の欄は棟へ", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: {
        price: "6590",
        exclusiveArea: "67.21",
        managementFee: "12800",
        structure: "RC",
        totalFloors: "11",
        totalUnits: "48",
        builtYearMonth: "2008年3月",
      },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({ salePrice: 6590, exclusiveArea: 67.21, managementFee: 12800 });
    expect(r.building).toEqual({
      structureType: "RC",
      totalFloors: 11,
      totalUnits: 48,
      builtYear: 2008,
      builtMonth: 3,
    });
  });

  it("棟が無い区分では棟の欄を捨てる", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { price: "6590", structure: "RC" },
      current: { property: {}, building: null },
    });
    expect(r.property).toEqual({ salePrice: 6590 });
    expect(r.building).toEqual({});
  });
});

describe("buildWriteback — 一棟", () => {
  it("棟には書かず物件へ(総戸数・利回り・満室想定収入を含む)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { totalUnits: "24", grossYield: "8.5", expectedIncome: "9800", structure: "RC" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({
      totalUnits: 24,
      grossYield: 8.5,
      expectedIncome: 9800,
      structureType: "RC",
    });
    expect(r.building).toEqual({});
  });
});

// [@codex P2] 図面側の入力上限(交通=500字)は物件列の上限(200字)より緩い。上限を見ずに
// 保存すると、物件編集画面の検証を通らない値が列に入り、以後その物件を普通の編集画面から
// 保存できなくなる。切り詰めず「読めなかった欄」として返す。
describe("buildWriteback — 文字数の上限(@codex P2)", () => {
  it("交通は200字まで保存し、201字は読めなかった欄にする", () => {
    const ok = buildWriteback({
      kind: "land",
      values: { access: "あ".repeat(200) },
      current: emptyCurrent,
    });
    expect(ok.property).toEqual({ access: "あ".repeat(200) });
    expect(ok.unreadable).toEqual([]);

    const tooLong = buildWriteback({
      kind: "land",
      values: { access: "あ".repeat(201) },
      current: emptyCurrent,
    });
    expect(tooLong.property).toEqual({});
    expect(tooLong.unreadable).toEqual(["交通"]);
  });

  it("勝手に切り詰めない(図面の文と物件の文が食い違わないように)", () => {
    const r = buildWriteback({
      kind: "land",
      values: { access: "あ".repeat(300) },
      current: emptyCurrent,
    });
    expect(Object.keys(r.property)).not.toContain("access");
  });

  it("間取り・バルコニー向きは50字まで", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { layout: "あ".repeat(51), balconyDir: "南".repeat(50) },
      current: { property: {}, building: null },
    });
    expect(r.property).toEqual({ orientation: "南".repeat(50) });
    expect(r.unreadable).toEqual(["間取り"]);
  });
});

// [@codex P2] DECIMAL(p,s) の桁あふれは DB が黙って丸める＝図面・変更履歴・物件の値が
// 食い違ったまま残る。範囲外の値と同じく、その欄だけ保存しない。
describe("buildWriteback — 小数の桁(@codex P2)", () => {
  it("価格(DECIMAL(12,1))は小数1桁まで", () => {
    const ok = buildWriteback({
      kind: "land",
      values: { price: "3480.5" },
      current: emptyCurrent,
    });
    expect(ok.property).toEqual({ salePrice: 3480.5 });
    expect(ok.unreadable).toEqual([]);

    const over = buildWriteback({
      kind: "land",
      values: { price: "3480.55" },
      current: emptyCurrent,
    });
    expect(over.property).toEqual({});
    expect(over.unreadable).toEqual(["価格"]);
  });

  it("土地面積(DECIMAL(10,2))は小数2桁まで", () => {
    const ok = buildWriteback({
      kind: "land",
      values: { landArea: "125.30" },
      current: emptyCurrent,
    });
    expect(ok.property).toEqual({ landArea: 125.3 });

    const over = buildWriteback({
      kind: "land",
      values: { landArea: "125.305" },
      current: emptyCurrent,
    });
    expect(over.property).toEqual({});
    expect(over.unreadable).toEqual(["土地面積"]);
  });

  it("想定利回り(DECIMAL(5,2))も桁で弾く", () => {
    const r = buildWriteback({
      kind: "building",
      values: { grossYield: "4.125" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["想定利回り"]);
  });
});
