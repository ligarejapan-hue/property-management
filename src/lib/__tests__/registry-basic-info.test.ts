import { describe, expect, it } from "vitest";
import {
  isRegistryWarningNotice,
  parseRegistryBuildingFacts,
  planBuildingFactsFill,
  planPropertyBasicFill,
  registryFillNotice,
  registryIdentityOf,
} from "../registry-basic-info";

// 架空の区分建物の全部事項(登記情報提供サービスの PDF の文字の並びをまねたもの)。
const unit = (opts: { structure?: string[]; exclusive?: string[]; extraHead?: string[] } = {}) =>
  [
    "┏━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃専有部分の家屋番号│１－１－１ ～ １－１－４３ ┃",
    "┃ 表 題 部 （一棟の建物の表示） │調製│平成７年１１月２２日 │所在図番号│ ┃",
    "┃所 在│世田谷区架空一丁目 １番地１ │ ┃",
    "┃建物の名称│架空マンション │ ┃",
    "┃ ① 構 造 │ ② 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    ...(opts.structure ?? [
      "┃鉄筋コンクリート造陸屋根５階建 │ １階 ５００：００│〔平成７年１１月２２日〕 ┃",
      "┃ │ ２階 ４８０：１２│ ┃",
    ]),
    "┃ 表 題 部 （敷地権の目的である土地の表示） ┃",
    "┃①土地の符号│②所在及び地番 │③地目│④地積 ㎡ │登記の日付 ┃",
    "┃ １ │世田谷区架空一丁目１番１ │宅地 │１０００：００│平成７年１１月１日 ┃",
    ...(opts.extraHead ?? []),
    "┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００１┃",
    "┃家屋番号 │架空一丁目 １番１の３８ │ ┃",
    "┃建物の名称│３０５ │ ┃",
    "┃ ① 種 類 │ ② 構 造 │ ③ 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    ...(opts.exclusive ?? ["┃居宅 │鉄筋コンクリート造１階建 │ ３階部分 ６３：５０│昭和６０年５月１日新築 ┃"]),
    "┃ 表 題 部 （敷地権の表示） ┃",
    "┃①土地の符号│②敷地権の種類│③敷地権の割合│原因及びその日付 ┃",
    "┃ １ │所有権 │１００００分の６３５│平成７年１１月１日敷地権 ┃",
    "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
  ].join("\n");

const house = (rows: string[]) =>
  [
    "┃ 表 題 部 （主である建物の表示） │調製│余白 │不動産番号│０１００００００００００２┃",
    "┃所 在│世田谷区架空二丁目 ２番地２ │ ┃",
    "┃家屋番号 │２番２ │ ┃",
    "┃ ① 種 類 │ ② 構 造 │ ③ 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
    ...rows,
    "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
  ].join("\n");

describe("謄本から構造と築年月を読む", () => {
  it("★区分: 構造は一棟の建物・築年月は専有部分から読む(専有部分の「１階建」を構造にしない)", () => {
    expect(parseRegistryBuildingFacts(unit())).toEqual({
      structureType: "鉄筋コンクリート造陸屋根5階建",
      builtYear: 1985,
      builtMonth: 5,
    });
  });

  it("★戸建: 主である建物の表示から読む", () => {
    expect(
      parseRegistryBuildingFacts(house(["┃居宅 │木造スレートぶき２階建 │ １階 ５０：００│平成元年３月２０日新築 ┃", "┃ │ │ ２階 ４０：００│ ┃"])),
    ).toEqual({ structureType: "木造スレートぶき2階建", builtYear: 1989, builtMonth: 3 });
  });

  it("行をまたいだ構造・日付をつなげて読む", () => {
    const r = parseRegistryBuildingFacts(
      unit({
        structure: ["┃鉄骨鉄筋コンクリート造陸屋根 │ １階 ５００：００│ ┃", "┃地下１階付１４階建 │ ２階 ４８０：１２│ ┃"],
        exclusive: ["┃居宅 │鉄筋コンクリート造１階建 │ ３階部分 ６３：５０│令和２年１０月１ ┃", "┃ │ │ │５日新築 ┃"],
      }),
    );
    expect(r).toEqual({ structureType: "鉄骨鉄筋コンクリート造陸屋根地下1階付14階建", builtYear: 2020, builtMonth: 10 });
  });

  it("平家建も読む・月日不詳は年だけ", () => {
    expect(parseRegistryBuildingFacts(house(["┃居宅 │木造瓦ぶき平家建 │ ５０：００│昭和５０年月日不詳新築 ┃"]))).toEqual({
      structureType: "木造瓦ぶき平家建",
      builtYear: 1975,
      builtMonth: null,
    });
  });

  it("★迷ったら読まない: 構造が2つある(変更の履歴)", () => {
    const r = parseRegistryBuildingFacts(
      house(["┃居宅 │木造瓦ぶき平家建 │ ５０：００│昭和５０年１月１日新築 ┃", "┃ │木造瓦ぶき２階建 │ ９０：００│昭和６０年２月３日増築 ┃"]),
    );
    expect(r.structureType).toBeNull();
    expect(r.builtYear).toBe(1975);
  });

  it("★新築の日付が2つあれば築年月を読まない・和暦の無い日付は読まない", () => {
    const two = house(["┃居宅 │木造２階建 │ ５０：００│昭和５０年１月１日新築 ┃", "┃ │ │ │昭和５１年１月１日新築 ┃"]);
    expect(parseRegistryBuildingFacts(two).builtYear).toBeNull();
    const none = house(["┃居宅 │木造２階建 │ ５０：００│年月日不詳新築 ┃"]);
    expect(parseRegistryBuildingFacts(none).builtYear).toBeNull();
  });

  it("★構造の列に所有者の行が来ても、氏名・住所を構造にしない", () => {
    const r = parseRegistryBuildingFacts(
      house(["┃居宅 │木造２階建 │ ５０：００│昭和５０年１月１日新築 ┃", "┃所 有 者 │架空区 架空太郎 │ │ ┃"]),
    );
    expect(r.structureType).toBe("木造2階建");
    const onlyOwner = parseRegistryBuildingFacts(house(["┃ │架空区 架空太郎 │ │ ┃"]));
    expect(onlyOwner.structureType).toBeNull();
  });

  it("★構造の後ろに別の文字が付いたら読まない", () => {
    const r = parseRegistryBuildingFacts(house(["┃居宅 │木造２階建 │ ５０：００│昭和５０年１月１日新築 ┃", "┃ │架空太郎 │ │ ┃"]));
    expect(r.structureType).toBeNull();
  });

  it("所有者事項・土地の謄本・空の文字からは読まない", () => {
    const none = { structureType: null, builtYear: null, builtMonth: null };
    expect(parseRegistryBuildingFacts("")).toEqual(none);
    expect(parseRegistryBuildingFacts("┃ 表 題 部 （土地の表示） ┃\n┃①地番│②地目│③地積 ㎡ │原因 ┃\n┃１番１│宅地│１００：００│ ┃\n┃ 権 利 部 ┃")).toEqual(none);
  });

  it("2棟を1つにまとめた PDF は読まない", () => {
    const one = house(["┃居宅 │木造２階建 │ ５０：００│昭和５０年１月１日新築 ┃"]);
    expect(parseRegistryBuildingFacts(`${one}\n${one}`).structureType).toBeNull();
  });
});

describe("地番と家屋番号を、謄本の取得で読める形にする", () => {
  it("★区分: 町名を落とす・全角を半角にする(町名が残ると謄本の取得が「読めない番号」で止まる)", () => {
    const raw = unit();
    expect(registryIdentityOf(raw)).toEqual({ lotNumber: "1番1", buildingNumber: "1番1の38" });
  });

  it("★不動産番号が2つ以上ある=2件を1つにまとめた PDF は入れない", () => {
    const raw = `${unit()}\n┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００９┃`;
    expect(registryIdentityOf(raw)).toEqual({ lotNumber: null, buildingNumber: null });
  });

  it.each(["１番１の", "の３８", "架空一丁目 １番１－", "番１"])("★切れた番号「%s」は入れない(取得で別の登記を指す)", (v) => {
    const raw = `┃家屋番号 │${v} │ ┃`;
    expect(registryIdentityOf(raw).buildingNumber).toBeNull();
  });

  it.each(["１番１の ３８", "架空一丁目 １番 １", "の ３８", "架空町の ３８", "架空３丁目 １番１", "架空一丁目 ３８"])(
    "★番号の途中に空白がある・町名か決められない「%s」は入れない(末尾だけ取ると別の番号になる)",
    (v) => {
      const raw = `┃家屋番号 │${v} │ ┃`;
      expect(registryIdentityOf(raw).buildingNumber).toBeNull();
    },
  );

  it("町名が2語でも、前が町名だけなら番号を読む", () => {
    const raw = "┃家屋番号 │架空 一丁目 ５番１の３ │ ┃";
    expect(registryIdentityOf(raw).buildingNumber).toBe("5番1の3");
  });

  it("「５番」のように番で終わる番号は入れる", () => {
    const raw = "┃家屋番号 │５番 │ ┃";
    expect(registryIdentityOf(raw).buildingNumber).toBe("5番");
  });

  const landDoc = (rows: string[]) =>
    [
      "┃ 表 題 部 （土地の表示） │調製│余白 │不動産番号│０１００００００００００３┃",
      "┃所 在│世田谷区架空一丁目 │ ┃",
      "┃① 地 番 │② 地 目 │③ 地 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
      ...rows,
      "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
    ].join("\n");
  const lotOf = (raw: string) => registryIdentityOf(raw).lotNumber;

  it("★土地: 地番の欄全体を読む", () => {
    expect(lotOf(landDoc(["┃１番１ │宅地 │１００：００│ ┃"]))).toBe("1番1");
    expect(lotOf(landDoc(["┃１番１の２ │宅地 │１００：００│ ┃"]))).toBe("1番1の2");
    expect(lotOf(landDoc(["┃１２３番 │宅地 │１００：００│ ┃", "┃ │ │：│〔昭和５０年１月５日〕 ┃"]))).toBe("123番");
  });

  it("★土地: 途中に空白がある・地番が2つある(履歴)ものは入れない", () => {
    expect(lotOf(landDoc(["┃１番 １ │宅地 │１００：００│ ┃"]))).toBeNull();
    expect(lotOf(landDoc(["┃１番１ │宅地 │１００：００│ ┃", "┃１番５ │宅地 │５０：００│分筆 ┃"]))).toBeNull();
  });

  const siteDoc = (rows: string[]) =>
    [
      "┃ 表 題 部 （敷地権の目的である土地の表示） ┃",
      "┃①土地の符号│②所在及び地番 │③地目│④地積 ㎡ │登記の日付 ┃",
      ...rows,
      "┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００１┃",
    ].join("\n");

  it("★区分: 敷地が1筆なら読む(行の折り返しはつなげる)", () => {
    expect(lotOf(siteDoc(["┃ １ │世田谷区架空一丁目１番１ │宅地 │１０００：００│ ┃"]))).toBe("1番1");
    expect(lotOf(siteDoc(["┃ １ │世田谷区架空一丁目 │宅地 │１０００：００│ ┃", "┃ │１番１ │ │ │ ┃"]))).toBe("1番1");
  });

  it("★区分: 敷地が2筆・途中に空白・町名に数字があるものは入れない", () => {
    expect(lotOf(siteDoc(["┃ １ │世田谷区架空一丁目１番１ │宅地 │１０００：００│ ┃", "┃ ２ │世田谷区架空一丁目１番２ │宅地 │５００：００│ ┃"]))).toBeNull();
    expect(lotOf(siteDoc(["┃ １ │世田谷区架空一丁目１番 １ │宅地 │１０００：００│ ┃"]))).toBeNull();
    expect(lotOf(siteDoc(["┃ １ │世田谷区架空３丁目１番１ │宅地 │１０００：００│ ┃"]))).toBeNull();
  });

  it("罫線の無い文字からは読まない", () => {
    expect(lotOf("地番 1番1 地目 宅地")).toBeNull();
  });

  // 実物(本番の謄本で確認 2026-11-02): 建物の謄本の所在は「町名 1番地1」で、右の欄は外字の余白。
  const GAIJI = "";
  const unitNoSite = (rows: string[]) =>
    [
      "┃ 表 題 部 （一棟の建物の表示） │調製│平成７年１１月２２日 │所在図番号│ ┃",
      ...rows,
      "┃建物の名称│架空マンション │ ┃",
      "┃ ① 構 造 │ ② 床 面 積 ㎡ │ 原因及びその日付〔登記の日付〕 ┃",
      "┃鉄筋コンクリート造陸屋根５階建 │ １階 ５００：００│〔平成７年１１月２２日〕 ┃",
      "┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００１┃",
      "┃ 権 利 部 （甲 区） （所 有 権 に 関 す る 事 項） ┃",
    ].join("\n");
  const SHOZAI_ONE = "┃所 在│世田谷区架空一丁目 １番地１ │ ┃";

  it("★敷地権の欄が無い区分: 所在の地番を「番」の書き方で読む", () => {
    expect(lotOf(unitNoSite([`┃所 在│世田谷区架空一丁目 １番地１ │${GAIJI} ┃`]))).toBe("1番1");
    expect(lotOf(unitNoSite(["┃所 在│世田谷区架空一丁目１２番地 │余白 ┃"]))).toBe("12番");
  });

  it("★戸建: 所在の地番を読む", () => {
    const r = registryIdentityOf(house(["┃居宅 │木造２階建 │ ５０：００│昭和５０年１月１日新築 ┃"]));
    expect(r).toEqual({ lotNumber: "2番2", buildingNumber: "2番2" });
  });

  it.each([
    ["地番が2つ", "┃所 在│世田谷区架空一丁目 １番地１、１番地２ │ ┃"],
    ["漢数字の地番が前にある", "┃所 在│世田谷区架空一丁目 二番地、１番地１ │ ┃"],
    ["空白で2つ", "┃所 在│世田谷区架空一丁目 １番地１ １番地２ │ ┃"],
    ["及び", "┃所 在│世田谷区架空一丁目 二番地及び１番地１ │ ┃"],
    ["町名に数字", "┃所 在│世田谷区架空３丁目 １番地１ │ ┃"],
    ["数字の無い所在", "┃所 在│世田谷区架空一丁目 │ ┃"],
    ["切れた番号", "┃所 在│世田谷区架空一丁目 １番地１の │ ┃"],
    ["番号の途中の外字", "┃所 在│世田谷区架空一丁目 １番１ │ ┃"],
    ["右の欄に変更の原因", "┃所 在│世田谷区架空一丁目 １番地１ │令和２年１月１日変更 ┃"],
  ])("★迷ったら読まない: %s", (_name, row) => {
    expect(lotOf(unitNoSite([row]))).toBeNull();
  });

  it("★迷ったら読まない: 次の行に所在の続きや履歴がある", () => {
    expect(lotOf(unitNoSite([SHOZAI_ONE, "┃ │１番地２ │ ┃"]))).toBeNull();
    expect(lotOf(unitNoSite([SHOZAI_ONE, "┠───┼───┨", "┃ │世田谷区架空一丁目 ５番地５ │令和２年１月１日変更 ┃"]))).toBeNull();
  });

  it("次の行が空なら読む", () => {
    expect(lotOf(unitNoSite([SHOZAI_ONE, `┃ │${GAIJI} │${GAIJI} ┃`]))).toBe("1番1");
  });

  it("★所在の行が2つある・建物の表が2つある(2件まとめた PDF)ものは読まない", () => {
    expect(lotOf(unitNoSite([SHOZAI_ONE, "┃所 在│世田谷区架空一丁目 ５番地５ │ ┃"]))).toBeNull();
    const one = house(["┃居宅 │木造２階建 │ ５０：００│昭和５０年１月１日新築 ┃"]);
    expect(lotOf(`${one}\n${one}`)).toBeNull();
  });

  it("★敷地権の欄があるのに決められない謄本は、所在へ逃げない", () => {
    const twoLots = unit({ extraHead: ["┃ ２ │世田谷区架空一丁目１番２ │宅地 │５００：００│ ┃"] });
    expect(lotOf(twoLots)).toBeNull();
    // 表の終わりが無い(途中で切れた)敷地権の欄。
    const cut = unit().split("\n").filter((l) => !/表 題 部 （専有|表 題 部 （敷地権の表示|権 利 部/.test(l)).join("\n");
    expect(lotOf(cut)).toBeNull();
  });

  it("★土地の謄本は所在から読まない", () => {
    const twoRows = landDoc(["┃１番１ │宅地 │１００：００│ ┃", "┃１番５ │宅地 │５０：００│分筆 ┃"]);
    expect(lotOf(twoRows.replace("世田谷区架空一丁目", "世田谷区架空一丁目 ９番地９"))).toBeNull();
  });

  it("★文字が所在の行で切れている謄本は読まない(続きの行を見落とす)", () => {
    expect(lotOf(`┃ 表 題 部 （一棟の建物の表示） ┃\n${SHOZAI_ONE}`)).toBeNull();
  });

  it("★権利部の「所在」は読まない", () => {
    expect(lotOf("┃ 権 利 部 （甲 区） ┃\n┃所 在│世田谷区架空一丁目 １番地１ │ ┃")).toBeNull();
  });

  it("★家屋番号が次の行に折り返している・値が2つあるものは入れない", () => {
    const wrapped = "┃家屋番号 │１番１ │ ┃\n┃ │の３８ │ ┃";
    expect(registryIdentityOf(wrapped).buildingNumber).toBeNull();
    const two = "┃家屋番号 │１番１ │ ┃\n┠───┼───┨\n┃家屋番号 │１番２ │ ┃";
    expect(registryIdentityOf(two).buildingNumber).toBeNull();
  });

  it("★家屋番号の次の行が別の項目なら読む・同じ値の繰り返しは1つ", () => {
    expect(registryIdentityOf("┃家屋番号 │１番１ │ ┃\n┃建物の名称│３０５ │ ┃").buildingNumber).toBe("1番1");
    expect(registryIdentityOf("┃家屋番号 │１番１ │ ┃\n┠───┼───┨\n┃家屋番号 │１番１ │ ┃").buildingNumber).toBe("1番1");
  });

  it("★罫線の無い文字・「専有部分の家屋番号」(範囲)からは読まない", () => {
    expect(registryIdentityOf("家屋番号 １番１").buildingNumber).toBeNull();
    expect(registryIdentityOf("┃専有部分の家屋番号│１番１ │ ┃").buildingNumber).toBeNull();
  });

  it("読めない形は入れない", () => {
    const raw = "┃家屋番号 │未登記 │ ┃";
    expect(registryIdentityOf(raw).buildingNumber).toBeNull();
  });
});

const EMPTY_VALUES = { lotNumber: null, buildingNumber: null, structureType: null, builtYear: null, builtMonth: null };
const VALUES = { lotNumber: "1番1", buildingNumber: "1番1の38", structureType: "木造2階建", builtYear: 1985, builtMonth: 5 };
const current = (over: Record<string, unknown> = {}) => ({
  propertyType: "apartment_unit",
  buildingId: null as string | null,
  registryStatus: "unconfirmed",
  lotNumber: null as string | null,
  buildingNumber: null as string | null,
  structureType: null as string | null,
  builtYear: null as number | null,
  builtMonth: null as number | null,
  ...over,
});

describe("物件のどの欄を埋めるか", () => {
  it("★棟なしの区分: 空の欄を全部埋める", () => {
    expect(planPropertyBasicFill(VALUES, current())).toEqual(VALUES);
  });

  it("★入っている欄は上書きしない", () => {
    expect(
      planPropertyBasicFill(VALUES, current({ lotNumber: "手入力", buildingNumber: "手入力", structureType: "RC", builtYear: 2000, builtMonth: null })),
    ).toEqual({});
  });

  it("★棟に紐づく部屋: 構造と築年月は物件に書かない(棟の値が正)", () => {
    expect(planPropertyBasicFill(VALUES, current({ buildingId: "b-1" }))).toEqual({ lotNumber: "1番1", buildingNumber: "1番1の38" });
  });

  it("★土地: 家屋番号・構造・築年月を入れない(家屋番号が入ると謄本の取得が建物へ切り替わる)", () => {
    expect(planPropertyBasicFill(VALUES, current({ propertyType: "land" }))).toEqual({ lotNumber: "1番1" });
  });

  it("編集画面に欄の無い種別には構造と築年月を入れない", () => {
    expect(planPropertyBasicFill(VALUES, current({ propertyType: "store" }))).toEqual({ lotNumber: "1番1", buildingNumber: "1番1の38" });
  });

  it("★謄本の自動取得中: 地番・家屋番号は入れない(構造と築年月は入れる)", () => {
    expect(planPropertyBasicFill(VALUES, current({ registryStatus: "scheduled" }))).toEqual({
      structureType: "木造2階建",
      builtYear: 1985,
      builtMonth: 5,
    });
  });

  it("読めなかった値では何も書かない", () => {
    expect(planPropertyBasicFill(EMPTY_VALUES, current())).toEqual({});
  });
});

describe("棟のどの欄を埋めるか", () => {
  const b = (over: Record<string, unknown> = {}) => ({ structureType: null, builtYear: null, builtMonth: null, ...over });
  it("★空の欄だけ埋める", () => {
    expect(planBuildingFactsFill(VALUES, b())).toEqual({ structureType: "木造2階建", builtYear: 1985, builtMonth: 5 });
    expect(planBuildingFactsFill(VALUES, b({ structureType: "RC", builtYear: 2000 }))).toEqual({});
  });
});

describe("画面に出す案内", () => {
  it("★読めない謄本は、反映されないことを必ず出す", () => {
    expect(registryFillNotice({ filled: [], skippedByEditLock: false, unreadable: true })).toContain("基本情報には反映されません");
  });
  it("入れた欄の名前を出す(同じ名前は1つ)", () => {
    const n = registryFillNotice({ filled: ["lotNumber", "builtYear", "builtMonth", "landAreaMethod"], skippedByEditLock: false, unreadable: false });
    expect(n).toContain("地番");
    expect(n).toContain("築年月");
    expect(n?.match(/築年月/g)).toHaveLength(1);
    expect(n).not.toContain("landAreaMethod");
  });
  it("★保存の失敗は「読めない」と言わず、押し直しを案内する", () => {
    const n = registryFillNotice({ filled: [], skippedByEditLock: false, unreadable: false, failed: true });
    expect(n).toContain("押し直して");
    expect(n).not.toContain("読めない");
  });
  it("★注意の案内を見分ける(緑の枠で出さない)", () => {
    const warn = [
      { filled: [], skippedByEditLock: false, unreadable: true },
      { filled: [], skippedByEditLock: true, unreadable: false },
      { filled: [], skippedByEditLock: false, unreadable: false, failed: true },
    ];
    for (const o of warn) expect(isRegistryWarningNotice(registryFillNotice(o))).toBe(true);
    expect(isRegistryWarningNotice(registryFillNotice({ filled: ["lotNumber"], skippedByEditLock: false, unreadable: false }))).toBe(false);
    expect(isRegistryWarningNotice(null)).toBe(false);
  });
  it("編集中で見送ったときはそれを出す", () => {
    expect(registryFillNotice({ filled: [], skippedByEditLock: true, unreadable: false })).toContain("編集中");
  });
  it("何も入れなかったとき: 添付では黙る・ボタンでは理由を出す", () => {
    const r = { filled: [], skippedByEditLock: false, unreadable: false };
    expect(registryFillNotice(r)).toBeNull();
    expect(registryFillNotice(r, { manual: true })).toContain("新しく入れる項目はありません");
  });
});

// 実物(本番の謄本で確認 2026-11-01): 古い謄本の「移記」の行では、余白が外字(私用領域の文字)で出る。
describe("移記の行の外字の余白", () => {
  const ITEKI = "";

  it("★区分: 構造が2行に折り返し、移記の行があっても構造を読む", () => {
    const f = parseRegistryBuildingFacts(unit({
      structure: [
        "┃鉄骨鉄筋コンクリート・鉄筋コ │ １階 ５００：００│余白 ┃",
        "┃ンクリート造陸屋根８階建 │ ２階 ４８０：１２│ ┃",
        `┃${ITEKI} │${ITEKI} ：│昭和６３年法務省令第３７号附則第２条第 ┃`,
        "┃ │ ：│２項の規定により移記 ┃",
        "┃ │ ：│平成９年３月１日 ┃",
      ],
    }));
    expect(f.structureType).toBe("鉄骨鉄筋コンクリート・鉄筋コンクリート造陸屋根8階建");
  });

  it("★戸建: 「建」だけ次の行に折り返し、移記の行があっても構造を読む", () => {
    const f = parseRegistryBuildingFacts(house([
      "┃居宅 │木・鉄骨造スレート葺３階 │１階 ５０：００│平成５年４月１日新築 ┃",
      "┃ │建 │２階 ４０：００│ ┃",
      `┃${ITEKI} │${ITEKI} │${ITEKI} ：│昭和６３年法務省令第３７号附則第２条第 ┃`,
      "┃ │ │ ：│２項の規定により移記 ┃",
    ]));
    expect(f.structureType).toBe("木・鉄骨造スレート葺3階建");
    expect(f.builtYear).toBe(1993);
    expect(f.builtMonth).toBe(4);
  });

  it("外字のほかに文字がある欄は空にしない(階建で終わらないので読まない)", () => {
    const f = parseRegistryBuildingFacts(house([
      "┃居宅 │木造スレート葺２階建 │１階 ５０：００│平成５年４月１日新築 ┃",
      `┃ │別棟 │ │ ┃`,
    ]));
    expect(f.structureType).toBeNull();
  });
});

describe("2筆以上・2棟以上の物件の案内", () => {
  const base = { skippedByEditLock: false, unreadable: false };
  it("足した行に入れた・入れるものが無い", () => {
    const extra = { target: "extra" as const, kind: "land" as const, number: "1番2" };
    expect(registryFillNotice({ ...base, filled: ["extraParcels"], parcel: extra })).toBe("ほかの土地・建物(土地 1番2)の空いていた面積に入れました");
    expect(registryFillNotice({ ...base, filled: [], parcel: extra })).toBeNull();
    expect(registryFillNotice({ ...base, filled: [], parcel: extra }, { manual: true })).toContain("ほかの土地・建物(土地 1番2)のものです");
  });
  it("どれでもない番号は注意の色で、足し方を添える(足した行が無い物件では入れた欄も出す)", () => {
    const unknown = { target: "unknown" as const, kind: "building" as const, number: "1番3" };
    const n = registryFillNotice({ ...base, filled: [], parcel: unknown });
    expect(n).toBe("この謄本の家屋番号(1番3)は、物件の家屋番号にもほかの土地・建物にもありません。2棟目以降なら、物件の編集の「土地・建物を足す」で足してください");
    expect(isRegistryWarningNotice(n)).toBe(true);
    expect(registryFillNotice({ ...base, filled: ["landArea"], parcel: unknown })).toMatch(/^基本情報の空いていた欄に入れました: 土地面積。この謄本の家屋番号/);
  });
  it("番号を読めない謄本(足した行がある物件)は反映しないと知らせる", () => {
    const n = registryFillNotice({ ...base, filled: [], parcel: { target: "unknown", kind: null, number: "" } });
    expect(n).toContain("どの土地・建物のものか分からないため");
    expect(isRegistryWarningNotice(n)).toBe(true);
  });
});
