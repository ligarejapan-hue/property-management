/**
 * まとめてある PDF を書類ごとに分ける(2026-10-28 発注者依頼)— ページの見分けと分け目の純関数。
 * 例は実物(物件概要書 藤和氷川台コープ710・18ページ)の各ページの見出しの読み取りを写した形。
 */
import { describe, it, expect } from "vitest";
import {
  BUNDLE_ORIGINAL_KIND,
  REGISTRY_KIND,
  classifyPageText,
  cutsOf,
  isSplitKind,
  needsOcr,
  proposeSegments,
  segmentFileName,
  segmentsFromCuts,
  validateSegments,
} from "../segments";

// 実物の各ページの読み取り(冒頭)。OCR の化けた字(�)もそのまま残す。
const P1 =
  "物件名 藤和氷川台コープ７１０号室\n専有面積 59.55㎡（18.01坪）\n間取り ２ＬＤＫ\n所在地 練馬区氷川台四丁目１６２番地２\n交 通 東京メトロ有楽町線『氷川台』駅徒歩３分\n権利形態 所有権\n土地面積 3352.98㎡\n用途地域 第１種低層住居専用地域\n構造 鉄骨鉄筋コンクリート造\n建築年月日 1984年\n管理費 月額 13,350円\n修繕積立金 月額 8,900円";
const P2 = "地 図 データ  ©2026 50 m \n徒 歩  250 m 、 4 分氷 川 台 駅";
const P3 = "東京都練馬区氷川台4丁目49-4付近\n60m 1:1127\nCopyright(C)2026 ZENRIN CO., LTD.";
const P4 = "桃妥��仕上表<物件概要>名称�在地販売戸数開発面積敷地面積";
const P5 = "2509967 藤和氷川台コープ 22頁 東京カンテイ\n<注>この情報は、分譲時のカタログからの転載です。";
const P6 = "縮尺率!��4006階平面較";
const P7 = "配置図��各階平面凶縮尽率��400";
const P9 = "登記年月:昭和59年4月12H各階平面図衣屋番号|水川人固有建物図面";
const P10 = "表示年月晶:2022/04��18��160-17��158-27";
const P11 = "������下記��������相違����������証明�����������1建築敷地地名地番2建物";
const P12 = "Na人台帳記載事項証明下記��������相違����証明(建築設備記1建築敷地地名地番";
const P13 = "O0407ALB04藤和氷川全7710��������固定資産(土地��家屋)関係証明書07還線馬区";
const P14 = "東京都練馬区氷川台4丁目162-2-710全部事項証明書(建物)専有部分��家屋番号表題部";
const P15 = "東京都練馬区氷川名4丁目162-2�710受付年月日��受付番号全部事項証明書(建物権利腁";

describe("classifyPageText(1ページの種類)", () => {
  it.each([
    ["物件概要書(見出しが画像で、本文に「修繕積立金」があっても管理費の通知にしない)", P1, "property_summary"],
    ["地図(Google の地図データ)", P2, "map_zoning"],
    ["用途地域の図(ZENRIN)", P3, "map_zoning"],
    ["パンフ(概要・仕上表)", P4, "brochure"],
    ["パンフ(分譲時のカタログ)", P5, "brochure"],
    ["建物図面(各階平面図)", P9, "drawings"],
    ["台帳記載事項証明", P12, "ledger_certificate"],
    ["題の読めない台帳記載事項証明の1枚目(建築敷地 地名地番)", P11, "ledger_certificate"],
    ["固定資産(土地・家屋)関係証明書", P13, "tax_certificate"],
    ["謄本の1ページ目", P14, REGISTRY_KIND],
    ["謄本の続きのページ(見出しに全部事項証明書)", P15, REGISTRY_KIND],
  ])("%s", (_label, text, kind) => {
    expect(classifyPageText(text)).toBe(kind);
  });

  it.each([
    ["見出しの読めない平面図", P6],
    ["化けた「各階平面凶」", P7],
    ["公図(表示年月日だけ)", P10],
    ["空", ""],
  ])("見分けられないページは null(=前の書類の続き): %s", (_label, text) => {
    expect(classifyPageText(text)).toBeNull();
  });

  it("本文の奥(見出しの外)にだけある語では決めない", () => {
    expect(classifyPageText("ご案内\n" + "あ".repeat(800) + "売買契約書")).toBeNull();
  });

  it("全部事項の権利部(甲区)がある本文は、見出しが崩れていても謄本", () => {
    expect(classifyPageText("東京都… 権 利 部 （ 甲 区 ） （ 所 有 権 に 関 す る 事 項 ）")).toBe(REGISTRY_KIND);
  });
});

describe("proposeSegments(分け方の案)", () => {
  it("実物18ページ → 7つの書類", () => {
    const kinds = [P1, P2, P3, P4, P5, P6, P7, P6, P9, P10, P11, P12, P13, P14, P15, P15, P15, P15].map(classifyPageText);
    expect(proposeSegments(kinds)).toEqual([
      { from: 1, to: 1, kind: "property_summary" },
      { from: 2, to: 3, kind: "map_zoning" },
      { from: 4, to: 8, kind: "brochure" },
      { from: 9, to: 10, kind: "drawings" },
      { from: 11, to: 12, kind: "ledger_certificate" },
      { from: 13, to: 13, kind: "tax_certificate" },
      { from: 14, to: 18, kind: REGISTRY_KIND },
    ]);
  });

  it("1ページ目が見分けられないときは「その他」で始める", () => {
    expect(proposeSegments([null, "drawings", null])).toEqual([
      { from: 1, to: 1, kind: null },
      { from: 2, to: 3, kind: "drawings" },
    ]);
  });

  it("全部同じ種類なら1つ", () => {
    expect(proposeSegments([REGISTRY_KIND, REGISTRY_KIND])).toEqual([{ from: 1, to: 2, kind: REGISTRY_KIND }]);
  });

  it("0ページなら空", () => {
    expect(proposeSegments([])).toEqual([]);
  });
});

describe("segmentsFromCuts(分け目を動かしたあと)", () => {
  const pageKinds = ["property_summary", "map_zoning", null, "brochure", null];

  it("案の分け目をそのまま使うと案と同じ", () => {
    const proposal = proposeSegments(pageKinds);
    expect(segmentsFromCuts(pageKinds, cutsOf(proposal), new Map())).toEqual(proposal);
  });

  it("分け目を消すと前の書類に合わさり、種類は前の書類のまま", () => {
    expect(segmentsFromCuts(pageKinds, new Set([2]), new Map())).toEqual([
      { from: 1, to: 1, kind: "property_summary" },
      { from: 2, to: 5, kind: "map_zoning" },
    ]);
  });

  it("分け目を足すと、新しい書類の種類はその中で最初に見分けられたページの種類(無ければその他)", () => {
    expect(segmentsFromCuts(pageKinds, new Set([2, 3, 4, 5]), new Map())).toEqual([
      { from: 1, to: 1, kind: "property_summary" },
      { from: 2, to: 2, kind: "map_zoning" },
      { from: 3, to: 3, kind: null },
      { from: 4, to: 4, kind: "brochure" },
      { from: 5, to: 5, kind: null },
    ]);
  });

  it("人が選び直した種類は、分け目を動かしても始まりのページが同じなら残る", () => {
    const chosen = new Map<number, string | null>([[4, "drawings"]]);
    expect(segmentsFromCuts(pageKinds, new Set([2, 4]), chosen)).toEqual([
      { from: 1, to: 1, kind: "property_summary" },
      { from: 2, to: 3, kind: "map_zoning" },
      { from: 4, to: 5, kind: "drawings" },
    ]);
  });

  it("1ページ目や範囲の外の分け目は無視する", () => {
    expect(segmentsFromCuts([null, null], new Set([1, 3, 0]), new Map())).toEqual([{ from: 1, to: 2, kind: null }]);
  });
});

describe("validateSegments(保存の前の確かめ)", () => {
  it("1ページ目から最後まで隙間なく並んだものだけ通す", () => {
    expect(
      validateSegments(
        [
          { from: 1, to: 1, kind: "property_summary" },
          { from: 2, to: 4, kind: REGISTRY_KIND },
          { from: 5, to: 5, kind: null },
        ],
        5,
      ),
    ).toEqual({
      ok: true,
      segments: [
        { from: 1, to: 1, kind: "property_summary" },
        { from: 2, to: 4, kind: REGISTRY_KIND },
        { from: 5, to: 5, kind: null },
      ],
    });
  });

  it.each([
    ["配列でない", { from: 1 }],
    ["1つだけ(分ける意味がない)", [{ from: 1, to: 3, kind: null }]],
    ["隙間がある", [{ from: 1, to: 1, kind: null }, { from: 3, to: 3, kind: null }]],
    ["重なっている", [{ from: 1, to: 2, kind: null }, { from: 2, to: 3, kind: null }]],
    ["最後まで届かない", [{ from: 1, to: 1, kind: null }, { from: 2, to: 2, kind: null }]],
    ["範囲の外", [{ from: 1, to: 1, kind: null }, { from: 2, to: 4, kind: null }]],
    ["知らない種類", [{ from: 1, to: 1, kind: "nope" }, { from: 2, to: 3, kind: null }]],
    ["元のファイルの種類は分けた書類に使えない", [{ from: 1, to: 1, kind: BUNDLE_ORIGINAL_KIND }, { from: 2, to: 3, kind: null }]],
    ["整数でない", [{ from: 1, to: 1.5, kind: null }, { from: 2, to: 3, kind: null }]],
  ])("通さない: %s", (_label, raw) => {
    expect(validateSegments(raw, 3).ok).toBe(false);
  });
});

describe("そのほか", () => {
  it("isSplitKind: 種類の表の種類・謄本・その他(null)は使える。元のファイルの種類は使えない", () => {
    expect(isSplitKind("drawings")).toBe(true);
    expect(isSplitKind(REGISTRY_KIND)).toBe(true);
    expect(isSplitKind(null)).toBe(true);
    expect(isSplitKind(BUNDLE_ORIGINAL_KIND)).toBe(false);
    expect(isSplitKind("nope")).toBe(false);
  });

  it("needsOcr: 文字がほとんど無いページだけ読み取りに回す", () => {
    expect(needsOcr("")).toBe(true);
    expect(needsOcr("  \n 12 ")).toBe(true);
    expect(needsOcr(P1)).toBe(false);
  });

  it("segmentFileName: 元の名前にページの範囲を付ける", () => {
    expect(segmentFileName("物件概要書 藤和氷川台コープ710.pdf", { from: 14, to: 18 })).toBe(
      "物件概要書 藤和氷川台コープ710_p14-18.pdf",
    );
    expect(segmentFileName("bundle.PDF", { from: 1, to: 1 })).toBe("bundle_p1.pdf");
    expect(segmentFileName("noext", { from: 2, to: 3 })).toBe("noext_p2-3.pdf");
  });
});
