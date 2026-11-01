import { describe, expect, it } from "vitest";
import { parseBuildingFloorArea, parseLandArea, planRegistryAreaFill } from "../registry-area";

// 架空の全部事項(登記情報提供サービスの PDF の文字の並びをまねたもの)。

const land = (rows: string[]) =>
  [
    "┃ 表 題 部 （土地の表示） │調製│余白 │不動産番号│０１０００００００００２┃",
    "┃地図番号│余白 │筆界特定│余白 ┃",
    "┃所 在│世田谷区架空一丁目 │余白 ┃",
    "┃ ① 地 番 │②地 目 │ ③ 地 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    ...rows,
    "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
    "┃ １ │所有権移転│ │所有者 架空区 ９９：９９ 架空太郎 ┃",
    "┃ 共 同 担 保 目 録 ┃",
    "┃ １ │世田谷区架空一丁目 ２番の土地 │ ５００：００ ┃",
  ].join("\n");

const house = (rows: string[], extra: string[] = []) =>
  [
    "┃ 表 題 部 （主である建物の表示） │調製│余白 │不動産番号│０１０００００００００３┃",
    "┃所在図番号│余白 ┃",
    "┃所 在│世田谷区架空一丁目 １番地１ │余白 ┃",
    "┃家屋番号 │１番１ │余白 ┃",
    "┃ ① 種 類 │ ② 構 造 │ ③ 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    ...rows,
    ...extra,
    "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
    "┃ １ │所有権保存│ │所有者 架空区 ３階 ９９：９９ 架空太郎 ┃",
  ].join("\n");

describe("土地の謄本から地積を読む", () => {
  it("★表題部の地積を読む(権利部・共同担保目録の数字は読まない)", () => {
    expect(parseLandArea(land(["┃１番１ │宅地 │ １２０：５０│余白 ┃"]))).toEqual({ value: "120.50", skippedReason: null });
  });

  it("小数の無い地積(田・畑など)と、中点・半角の小数点も読む", () => {
    expect(parseLandArea(land(["┃１番１ │畑 │ ３５０ │余白 ┃"])).value).toBe("350.00");
    expect(parseLandArea(land(["┃１番１ │宅地 │ ９８・０５│余白 ┃"])).value).toBe("98.05");
    expect(parseLandArea(land(["┃1番1 │宅地 │ 98.05│余白 ┃"])).value).toBe("98.05");
  });

  it("地目だけ変わった行(地積は余白)は1つの地積として読む", () => {
    const r = parseLandArea(
      land(["┃１番１ │畑 │ １２０：５０│余白 ┃", "┃余白 │宅地 │余白 │②令和２年１月５日地目変更 ┃"]),
    );
    expect(r.value).toBe("120.50");
  });

  it("★地積が2つ以上ある(地積更正・分筆の履歴)ときは読まない", () => {
    const r = parseLandArea(
      land(["┃１番１ │宅地 │ １２０：５０│余白 ┃", "┃余白 │余白 │ １１０：００│③錯誤 ┃"]),
    );
    expect(r.value).toBeNull();
    expect(r.skippedReason).toContain("履歴");
  });

  it("地積の欄が数字として読めないときは読まない", () => {
    expect(parseLandArea(land(["┃１番１ │宅地 │ １２０： │余白 ┃"])).value).toBeNull();
  });

  it("★区分建物の「敷地権の目的である土地の表示」は土地の地積として読まない", () => {
    const text = [
      "┃ 表 題 部 （敷地権の目的である土地の表示） ┃",
      "┃①土地の符号│ ②所 在 及 び 地 番 │③地 目│ ④ 地 積 ㎡ │ 登 記 の 日 付 ┃",
      "┃ １ │世田谷区架空一丁目１番１ │宅地 │ １２００：００│平成７年１１月２２日 ┃",
    ].join("\n");
    expect(parseLandArea(text).value).toBeNull();
  });

  it("土地の表示が無い・罫線の無い文字だけのときは読まない", () => {
    expect(parseLandArea(house(["┃居宅 │木造２階建 │ １階 ５０：００│新築 ┃"])).value).toBeNull();
    expect(parseLandArea("表題部（土地の表示）\n地番 地目 地積\n1番1 宅地 120.50").value).toBeNull();
  });
});

describe("建物の謄本から床面積の合計を読む", () => {
  it("★各階の床面積を足す(構造の「２階建」は数えない)", () => {
    const r = parseBuildingFloorArea(
      house(["┃居宅 │木造スレートぶき２階建 │ １階 ５０：２５│令和２年１月５日新築 ┃", "┃ │ │ ２階 ４０：８０│ ┃"]),
    );
    expect(r).toEqual({ value: "91.05", skippedReason: null });
  });

  it("平家建で階の書き方が無い床面積も読む", () => {
    expect(parseBuildingFloorArea(house(["┃居宅 │木造平家建 │ ８０：００│新築 ┃"])).value).toBe("80.00");
  });

  it("地下の階も別の階として足す", () => {
    const r = parseBuildingFloorArea(
      house(["┃居宅 │鉄筋コンクリート造 │ 地下１階 ３０：００│新築 ┃", "┃ │ │ １階 ５０：００│ ┃"]),
    );
    expect(r.value).toBe("80.00");
  });

  it("★附属建物の床面積は足さない", () => {
    const r = parseBuildingFloorArea(
      house(["┃居宅 │木造平家建 │ １階 ６０：００│新築 ┃"], [
        "┃ 表 題 部 （附属建物の表示） ┃",
        "┃符号│①種 類│ ② 構 造 │ ③ 床 面 積 ㎡ │ 原因及びその日付 ┃",
        "┃ １ │物置 │木造平家建 │ １階 ５：００│ ┃",
      ]),
    );
    expect(r.value).toBe("60.00");
  });

  it("★同じ階が2回出る(増築などの履歴)ときは読まない", () => {
    const r = parseBuildingFloorArea(
      house([
        "┃居宅 │木造平家建 │ １階 ５０：００│新築 ┃",
        "┃余白 │木造２階建 │ １階 ５０：００│③令和２年１月５日増築 ┃",
        "┃ │ │ ２階 ３０：００│ ┃",
      ]),
    );
    expect(r.value).toBeNull();
  });

  it("★階ごとに1回ずつでも、変更の原因(増築・変更・一部取壊しなど)があれば読まない", () => {
    for (const cause of ["③令和２年１月５日増築", "②③令和２年１月５日変更", "③一部取壊し", "③錯誤"]) {
      const r = parseBuildingFloorArea(
        house(["┃居宅 │ │ １階 ５０：００│新築 ┃", `┃ │ │ ２階 ３０：００│${cause} ┃`]),
      );
      expect(r.value, cause).toBeNull();
    }
  });

  it("床面積の欄に読めない文字があるときは読まない", () => {
    expect(parseBuildingFloorArea(house(["┃居宅 │ │ １階 ５０：│新築 ┃"])).value).toBeNull();
  });

  it("区分建物の謄本(一棟の建物・専有部分)は建物の床面積として読まない", () => {
    const text = [
      "┃ 表 題 部 （一棟の建物の表示） │調製│ ┃",
      "┃ ① 構 造 │ ② 床 面 積 ㎡ │ 原因及びその日付 ┃",
      "┃鉄筋コンクリート造５階建 │ １階 ５００：００│ ┃",
      "┃ 表 題 部 （専有部分の建物の表示） ┃",
      "┃ ① 種 類 │ ② 構 造 │ ③ 床 面 積 ㎡ │ 原因及びその日付 ┃",
      "┃居宅 │ │ ３階部分 ６３：５０│ ┃",
    ].join("\n");
    expect(parseBuildingFloorArea(text).value).toBeNull();
  });
});

describe("物件の種別ごとに、空の欄だけ埋める", () => {
  const areas = { unitFloorArea: "63.50", landArea: "120.50", buildingFloorArea: "91.05" };
  const empty = { exclusiveAreaRegistry: null, landArea: null, landAreaMethod: null, totalFloorArea: null };

  it("区分マンション=専有面積(登記簿)だけ", () => {
    expect(planRegistryAreaFill(areas, { ...empty, propertyType: "apartment_unit" })).toEqual({
      exclusiveAreaRegistry: "63.50",
    });
  });

  it("★土地=土地面積と計測方式「公簿」", () => {
    expect(planRegistryAreaFill(areas, { ...empty, propertyType: "land" })).toEqual({
      landArea: "120.50",
      landAreaMethod: "公簿",
    });
  });

  it("★戸建・一棟=土地面積(土地の謄本)と建物面積(建物の謄本)", () => {
    expect(planRegistryAreaFill(areas, { ...empty, propertyType: "house" })).toEqual({
      landArea: "120.50",
      landAreaMethod: "公簿",
      totalFloorArea: "91.05",
    });
    expect(planRegistryAreaFill({ unitFloorArea: null, landArea: null, buildingFloorArea: "300.00" }, {
      ...empty,
      propertyType: "apartment_building",
    })).toEqual({ totalFloorArea: "300.00" });
  });

  it("★入っている値は上書きしない・計測方式が入っていれば変えない", () => {
    expect(
      planRegistryAreaFill(areas, { ...empty, propertyType: "house", landArea: "100", totalFloorArea: "80" }),
    ).toEqual({});
    expect(planRegistryAreaFill(areas, { ...empty, propertyType: "land", landAreaMethod: "実測" })).toEqual({
      landArea: "120.50",
    });
  });

  it("種別が不明・その他なら何も入れない", () => {
    expect(planRegistryAreaFill(areas, { ...empty, propertyType: "other" })).toEqual({});
    expect(planRegistryAreaFill(areas, { ...empty, propertyType: "building" })).toEqual({});
  });
});

describe("迷う謄本は読まない(内部レビュー)", () => {
  it("★土地の表示が2つ以上ある(2筆を1つの PDF にまとめた)ときは読まない", () => {
    const one = land(["┃１番１ │宅地 │ １２０：５０│余白 ┃"]);
    expect(parseLandArea(`${one}\n${one}`).value).toBeNull();
  });

  it("★主である建物の表示が2つ以上あるときは読まない", () => {
    const one = house(["┃居宅 │木造平家建 │ ８０：００│新築 ┃"]);
    expect(parseBuildingFloorArea(`${one}\n${one}`).value).toBeNull();
  });

  it("「敷地権の目的である土地の表示」の見出しが2行に折り返されても土地の地積として読まない", () => {
    const text = [
      "┃ 表 題 部 （敷地権の目的である",
      "土地の表示） ┃",
      "┃①土地の符号│ ②所 在 及 び 地 番 │③地 目│ ④ 地 積 ㎡ │ 登 記 の 日 付 ┃",
      "┃ １ │世田谷区架空一丁目１番１ │宅地 │ １２００：００│平成７年１１月２２日 ┃",
    ].join("\n");
    expect(parseLandArea(text).value).toBeNull();
  });
});

describe("表が途中で切れている文字は読まない(@codex PR#593 P2)", () => {
  it("★土地: 表の終わり(権利部)が無い=後ろに更正の行があるかもしれないので読まない", () => {
    const cut = land(["┃１番１ │宅地 │ １２０：５０│余白 ┃"]).split("\n").slice(0, 5).join("\n");
    expect(cut).not.toContain("権 利 部");
    expect(parseLandArea(cut).value).toBeNull();
  });

  it("★建物: 表の終わりが無い=後ろに階や増築の行があるかもしれないので読まない", () => {
    const cut = house(["┃居宅 │木造２階建 │ １階 ５０：００│新築 ┃"]).split("\n").slice(0, 6).join("\n");
    expect(cut).not.toContain("権 利 部");
    expect(parseBuildingFloorArea(cut).value).toBeNull();
  });
});

describe("実物の謄本の並び(2026-11-01 本番で確認)", () => {
  const land = (rows: string[]) =>
    [
      "┃ 表 題 部 （土地の表示） │調製│余白 │不動産番号│０１００００００００００３┃",
      "┃所 在│世田谷区架空一丁目 │ ┃",
      "┃① 地 番 │② 地 目 │③ 地 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
      ...rows,
      "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
    ].join("\n");

  it("★原因の日付が折り返した行の、小数点だけの欄は空として読む", () => {
    expect(parseLandArea(land(["┃１番１ │宅地 │１２０：５０│昭和５０年１月１日 ┃", "┃ │ │ ：│〔昭和５０年１月５日〕 ┃"])).value).toBe("120.50");
  });

  it("★数字のある行が2つ(変更の履歴)は今までどおり読まない", () => {
    const r = parseLandArea(land(["┃１番１ │宅地 │１２０：５０│昭和５０年１月１日 ┃", "┃ │ │ ：│〔昭和５０年１月５日〕 ┃", "┃ │ │１００：００│昭和６０年１月１日地積更正 ┃"]));
    expect(r.value).toBeNull();
  });
});
