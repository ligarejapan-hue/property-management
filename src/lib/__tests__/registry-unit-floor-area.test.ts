import { describe, expect, it } from "vitest";
import { parseUnitFloorArea } from "../registry-unit-floor-area";

// 架空の区分建物の全部事項(登記情報提供サービスの PDF の文字の並びをまねたもの)。
const unit = (exclusiveRows: string[], extra: string[] = []) =>
  [
    "┏━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃専有部分の家屋番号│１－１－１ ～ １－１－４３ ┃",
    "┃ 表 題 部 （一棟の建物の表示） │調製│平成７年１１月２２日 │所在図番号│ ┃",
    "┃所 在│世田谷区架空一丁目 １番地１ │ ┃",
    "┃建物の名称│架空マンション │ ┃",
    "┃ ① 構 造 │ ② 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    "┃鉄筋コンクリート造陸屋根５階建 │ １階 ５００：００│〔平成７年１１月２２日〕 ┃",
    "┃ │ ２階 ４８０：１２│ ┃",
    "┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００１┃",
    "┃家屋番号 │架空一丁目 １番１の３８ │ ┃",
    "┃建物の名称│３０５ │ ┃",
    "┃ ① 種 類 │ ② 構 造 │ ③ 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    ...exclusiveRows,
    ...extra,
    "┃ 表 題 部 （敷地権の表示） ┃",
    "┃①土地の符号│②敷地権の種類│③敷地権の割合│原因及びその日付 ┃",
    "┃ １ │所有権 │１００００分の６３５│平成７年１１月１日敷地権 ┃",
    "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
    "┃ １ │所有権保存│ │所有者 架空区 ６階部分 ９９：９９ 架空太郎 ┃",
  ].join("\n");

describe("区分建物の謄本から専有部分の床面積(登記簿)を読む", () => {
  it("★専有部分の床面積を読む(一棟の建物の各階の面積は読まない)", () => {
    const r = parseUnitFloorArea(unit(["┃居宅 │鉄筋コンクリート造１階建 │ ３階部分 ６３：５０│平成７年１１月１日新築 ┃"]));
    expect(r).toEqual({ value: "63.50", skippedReason: null });
  });

  it("★権利部・敷地権の数字は読まない", () => {
    const r = parseUnitFloorArea(unit(["┃居宅 │鉄筋コンクリート造１階建 │ ３階部分 ６３：５０│ ┃"]));
    expect(r.value).toBe("63.50");
  });

  it("中点・半角・空白で割れた小数点も読む", () => {
    expect(parseUnitFloorArea(unit(["┃居宅 │ │ ３階部分 ６３・０５│ ┃"])).value).toBe("63.05");
    expect(parseUnitFloorArea(unit(["┃居宅 │ │ 3階部分 63:50│ ┃"])).value).toBe("63.50");
    expect(parseUnitFloorArea(unit(["┃居宅 │ │ ３階部分 ６３ ５０│ ┃"])).value).toBe("63.50");
    expect(parseUnitFloorArea(unit(["┃居宅 │ │ １２階 部分 １０５：００│ ┃"])).value).toBe("105.00");
  });

  it("★メゾネット(別の階)は足し合わせる", () => {
    const r = parseUnitFloorArea(
      unit(["┃居宅 │ │ ４階部分 ５０：２５│ ┃", "┃ │ │ ５階部分 ３０：８０│ ┃"]),
    );
    expect(r.value).toBe("81.05");
  });

  it("地下の階も別の階として数える", () => {
    const r = parseUnitFloorArea(unit(["┃店舗 │ │ 地下１階部分 ４０：００│ ┃", "┃ │ │ １階部分 ２０：００│ ┃"]));
    expect(r.value).toBe("60.00");
  });

  it("★同じ階が2つの数字で出る(床面積の変更の履歴)ときは読まない", () => {
    const r = parseUnitFloorArea(
      unit(["┃居宅 │ │ ３階部分 ６３：５０│ ┃", "┃ │ │ ３階部分 ６４：１０│②③令和２年１月５日変更 ┃"]),
    );
    expect(r.value).toBeNull();
    expect(r.skippedReason).toContain("変更の履歴");
  });

  it("同じ階・同じ数字が2回出ても1回と数える", () => {
    const r = parseUnitFloorArea(unit(["┃居宅 │ │ ３階部分 ６３：５０│ ┃", "┃ │ │ ３階部分 ６３：５０│ ┃"]));
    expect(r.value).toBe("63.50");
  });

  it("★附属建物の面積は足さない", () => {
    const r = parseUnitFloorArea(
      unit(["┃居宅 │ │ ３階部分 ６３：５０│ ┃"], ["┃ 表 題 部 （附属建物の表示） ┃", "┃ 1 │物置 │ １階部分 ３：００│ ┃"]),
    );
    expect(r.value).toBe("63.50");
  });

  it("専有部分の表示が無い(土地・一般の建物)・床面積が無いときは読まない", () => {
    expect(parseUnitFloorArea("表題部 (土地の表示)\n地積 １５０：００").value).toBeNull();
    expect(parseUnitFloorArea(unit([])).value).toBeNull();
    expect(parseUnitFloorArea(unit([])).skippedReason).toContain("読めません");
  });
});
