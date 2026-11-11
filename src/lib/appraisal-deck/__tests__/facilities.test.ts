/**
 * 周辺施設の読み取り(2026-11-11)。表の行・アイコンの色・位置の求め方。
 */
import { describe, it, expect } from "vitest";
import { classifyIconColor, locateFacilities, parseFacilityRows, SRE_ICON_COLORS, type FacilityPageRaw } from "../facilities";

const LINES = [
  "周辺施設情報",
  "最寄りの各種施設 直線距離 推定徒歩*1",
  "1 コンビニ デイリーヤマザキ\u0001見本町6丁目店 150\u0001m 2\u0001分",
  "2 スーパー まいばすけっと\u0001⻄見本駅北店 185\u0001m 3\u0001分",
  "3 薬局・ドラッグストア ツルハドラッグ\u0001見本店 169\u0001m 3\u0001分",
  "4 役所・公⺠館 架空区\u0001見本住区センター 122\u0001m 2\u0001分",
  "5 ⼩学校 架空区⽴見本⼩学校 266\u0001m 4\u0001分",
  "*1\u0001直線距離から推測した推定徒歩分となります。",
];

describe("parseFacilityRows", () => {
  it("種類・名前・距離・徒歩分を読む(SRE の部首の字・制御文字も直す)", () => {
    const rows = parseFacilityRows(LINES);
    expect(rows).toEqual([
      { cat: "コンビニ", name: "デイリーヤマザキ 見本町6丁目店", dist: 150, min: 2 },
      { cat: "スーパー", name: "まいばすけっと 西見本駅北店", dist: 185, min: 3 },
      { cat: "薬局・ドラッグストア", name: "ツルハドラッグ 見本店", dist: 169, min: 3 },
      { cat: "役所・公民館", name: "架空区 見本住区センター", dist: 122, min: 2 },
      { cat: "小学校", name: "架空区立見本小学校", dist: 266, min: 4 },
    ]);
  });
  it("表の見出しがなければ何も読まない・知らない種類は読まない", () => {
    expect(parseFacilityRows(LINES.slice(2))).toEqual([]);
    expect(parseFacilityRows(["最寄りの各種施設", "1 カラオケ 店 100 m 2 分"])).toEqual([]);
  });
});

describe("classifyIconColor", () => {
  it("凡例の色に近ければその種類・遠ければ null", () => {
    expect(classifyIconColor([255, 112, 4])).toBe("コンビニ");
    expect(classifyIconColor([185, 34, 34])).toBe("査定物件");
    expect(classifyIconColor([128, 128, 128])).toBeNull();
    expect(classifyIconColor(null)).toBeNull();
  });
});

describe("locateFacilities", () => {
  // 物件の印 (300,300)。縮尺 2.5m/点。北=PDF の上(y が大きい)
  const P = { x: 300, y: 300 };
  const icon = (cat: string, dx: number, dy: number) => ({ x: P.x + dx, y: P.y + dy, rgb: SRE_ICON_COLORS[cat] });
  const raw: FacilityPageRaw = {
    lines: LINES,
    icons: [
      { ...P, rgb: SRE_ICON_COLORS["査定物件"] },
      icon("コンビニ", -48, 24), // 150m 前後
      icon("コンビニ", 80, 80), // もっと遠いコンビニ
      icon("スーパー", 0, -74), // 185m 真南
      icon("薬局・ドラッグストア", 67.6, 0), // 169m 真東
      icon("役所・公民館", 0, 48.8), // 122m 真北
      // 小学校のアイコンは無い
    ],
  };
  it("物件の印からの向きと、表の距離から求めた縮尺で位置を出す(北が +y)", () => {
    const f = locateFacilities(raw);
    const by = Object.fromEntries(f.map((x) => [x.cat, x]));
    expect(by["スーパー"]).toMatchObject({ x: 0, y: -185 });
    expect(by["薬局・ドラッグストア"]).toMatchObject({ x: 169, y: 0 });
    expect(by["役所・公民館"]).toMatchObject({ x: 0, y: 122 });
    expect(Math.hypot(by["コンビニ"].x!, by["コンビニ"].y!)).toBeCloseTo(134, -1);
    expect(by["小学校"]).toMatchObject({ x: null, y: null }); // アイコンが無い=一覧だけ
  });
  it("物件の印が見つからない・2つある・縮尺がそろわないときは位置なし(一覧だけ)", () => {
    expect(locateFacilities({ ...raw, icons: raw.icons.slice(1) }).every((x) => x.x === null)).toBe(true);
    expect(locateFacilities({ ...raw, icons: [...raw.icons, { x: 10, y: 10, rgb: SRE_ICON_COLORS["査定物件"] }] }).every((x) => x.x === null)).toBe(true);
    const messy = { ...raw, icons: [raw.icons[0], icon("コンビニ", -10, 0), icon("スーパー", 0, -200), icon("薬局・ドラッグストア", 30, 0), icon("役所・公民館", 0, 300)] };
    expect(locateFacilities(messy).every((x) => x.x === null)).toBe(true);
  });
});
