import { describe, it, expect } from "vitest";
import {
  parseReceptionRows,
  applyReceptionFilters,
  isReceptionDlMarked,
  classifyShinki,
  DEFAULT_RECEPTION_FILTER_OPTIONS,
} from "../reception-owner-match";
import { isBlankHeader, filterNonBlankHeaders } from "../csv-parser";

// ヘッダ位置: A=No, B=DL, C=番号, D=受付日, E=新既, F=区分, G=原因, H=都道府県, I=区, J=住所, K=番地, L=他
function makeRow(opts: {
  dl?: string;
  shinki?: string;
  f?: string;
  h?: string;
  i?: string;
  j?: string;
  k?: string;
  other?: string;
}): string[] {
  return [
    "1",
    opts.dl ?? "",
    "",
    "",
    opts.shinki ?? "",
    opts.f ?? "土地",
    "",
    opts.h ?? "東京都",
    opts.i ?? "世田谷区",
    opts.j ?? "砧１丁目",
    opts.k ?? "3237-5",
    opts.other ?? "",
  ];
}

describe("isReceptionDlMarked", () => {
  it("半角○ / 全角〇 / 前後空白付きを 〇 として判定する", () => {
    expect(isReceptionDlMarked("〇")).toBe(true);
    expect(isReceptionDlMarked("○")).toBe(true);
    expect(isReceptionDlMarked(" 〇 ")).toBe(true);
    expect(isReceptionDlMarked("\t○\n")).toBe(true);
  });
  it("空 / null / undefined / 別文字は 〇なし", () => {
    expect(isReceptionDlMarked(null)).toBe(false);
    expect(isReceptionDlMarked(undefined)).toBe(false);
    expect(isReceptionDlMarked("")).toBe(false);
    expect(isReceptionDlMarked("×")).toBe(false);
    expect(isReceptionDlMarked("o")).toBe(false);
  });
});

describe("classifyShinki", () => {
  it("既 / 既存 / 前後空白付きを existing と判定する", () => {
    expect(classifyShinki("既")).toBe("existing");
    expect(classifyShinki("既存")).toBe("existing");
    expect(classifyShinki(" 既 ")).toBe("existing");
    expect(classifyShinki("\t既存\n")).toBe("existing");
  });
  it("新 / 新規 / 前後空白付きを new と判定する", () => {
    expect(classifyShinki("新")).toBe("new");
    expect(classifyShinki("新規")).toBe("new");
    expect(classifyShinki(" 新 ")).toBe("new");
    expect(classifyShinki("\t新規\n")).toBe("new");
  });
  it("null / undefined / 空欄 / 不明値は unknown", () => {
    expect(classifyShinki(null)).toBe("unknown");
    expect(classifyShinki(undefined)).toBe("unknown");
    expect(classifyShinki("")).toBe("unknown");
    expect(classifyShinki("   ")).toBe("unknown");
    expect(classifyShinki("既知")).toBe("unknown");
    expect(classifyShinki("新築")).toBe("unknown");
    expect(classifyShinki("その他")).toBe("unknown");
  });
});

describe("parseReceptionRows: DL/新既/他 抽出", () => {
  it("B/E/L 列を読んで dlMarked / shinkiValue / coOwnersNote にセットする", () => {
    const rows = parseReceptionRows([
      makeRow({ dl: "〇", shinki: "既存", other: "外3" }),
      makeRow({ dl: "", shinki: "新規", other: "" }),
    ]);
    expect(rows[0]).toMatchObject({
      dlMarked: true,
      shinkiValue: "既存",
      coOwnersNote: "外3",
    });
    expect(rows[1]).toMatchObject({
      dlMarked: false,
      shinkiValue: "新規",
      coOwnersNote: "",
    });
  });
});

describe("applyReceptionFilters", () => {
  const rows = parseReceptionRows([
    makeRow({ dl: "〇", shinki: "既存" }), // 0: 〇 + 既存
    makeRow({ dl: "○", shinki: "新規" }), // 1: 〇 + 新規
    makeRow({ dl: "", shinki: "既存" }),  // 2: なし + 既存
    makeRow({ dl: "", shinki: "新規" }),  // 3: なし + 新規
    makeRow({ dl: "", shinki: "" }),      // 4: なし + 不明
  ]);

  it("既定（marked × existing）: 〇 かつ 既存 のみ通す", () => {
    const out = applyReceptionFilters(rows, DEFAULT_RECEPTION_FILTER_OPTIONS);
    expect(out.map((r) => r.excluded)).toEqual([
      undefined,        // 〇 + 既存 → OK
      "filter_shinki",  // 〇 + 新規
      "filter_dl",      // なし + 既存
      "filter_dl",      // なし + 新規 (DL先評価)
      "filter_dl",      // なし + 不明
    ]);
  });

  it("dl=unmarked × shinki=new: 〇なし かつ 新規 のみ", () => {
    const out = applyReceptionFilters(rows, { dl: "unmarked", shinki: "new" });
    expect(out.map((r) => r.excluded)).toEqual([
      "filter_dl",
      "filter_dl",
      "filter_shinki",
      undefined,
      "filter_shinki",
    ]);
  });

  it("dl=all × shinki=all: 全行通る", () => {
    const out = applyReceptionFilters(rows, { dl: "all", shinki: "all" });
    expect(out.every((r) => r.excluded === undefined)).toBe(true);
  });

  it("既存の excluded（empty/header_repeat 等）はフィルタより優先して残す", () => {
    const emptyRow = parseReceptionRows([
      ["1", "", "", "", "", "", "", "", "", "", "", ""], // F/H/I/J/K 全空 → empty
    ]);
    const out = applyReceptionFilters(emptyRow, { dl: "marked", shinki: "existing" });
    expect(out[0].excluded).toBe("empty");
  });

  it("shinki=existing で 不明値は除外される（曖昧な寄せはしない）", () => {
    const out = applyReceptionFilters(rows, { dl: "all", shinki: "existing" });
    // 不明値の行 (index 4) は filter_shinki で除外される
    expect(out[4].excluded).toBe("filter_shinki");
  });

  it("既 / 新 の1文字表記が existing / new として通る", () => {
    const compactRows = parseReceptionRows([
      makeRow({ dl: "〇", shinki: "既" }),    // 0: 〇 + 既
      makeRow({ dl: "〇", shinki: "新" }),    // 1: 〇 + 新
      makeRow({ dl: "〇", shinki: " 既 " }),  // 2: 〇 + 前後空白付き既
      makeRow({ dl: "〇", shinki: "既知" }),  // 3: 〇 + 不明値
    ]);
    const existingOut = applyReceptionFilters(compactRows, {
      dl: "marked",
      shinki: "existing",
    });
    expect(existingOut.map((r) => r.excluded)).toEqual([
      undefined,        // 既 → existing OK
      "filter_shinki",  // 新 → not existing
      undefined,        // " 既 " → existing OK
      "filter_shinki",  // 既知 → unknown
    ]);
    const newOut = applyReceptionFilters(compactRows, {
      dl: "marked",
      shinki: "new",
    });
    expect(newOut.map((r) => r.excluded)).toEqual([
      "filter_shinki",
      undefined,
      "filter_shinki",
      "filter_shinki",
    ]);
  });

  it("既存 / 新規 の従来表記も引き続き existing / new として通る", () => {
    const fullRows = parseReceptionRows([
      makeRow({ dl: "〇", shinki: "既存" }),
      makeRow({ dl: "〇", shinki: "新規" }),
    ]);
    const existingOut = applyReceptionFilters(fullRows, {
      dl: "marked",
      shinki: "existing",
    });
    expect(existingOut[0].excluded).toBeUndefined();
    expect(existingOut[1].excluded).toBe("filter_shinki");
    const newOut = applyReceptionFilters(fullRows, {
      dl: "marked",
      shinki: "new",
    });
    expect(newOut[0].excluded).toBe("filter_shinki");
    expect(newOut[1].excluded).toBeUndefined();
  });
});

describe("isBlankHeader / filterNonBlankHeaders", () => {
  it("空文字 / 半角空白 / 全角空白 / タブ / 改行 / null / undefined はブランク", () => {
    expect(isBlankHeader("")).toBe(true);
    expect(isBlankHeader(" ")).toBe(true);
    expect(isBlankHeader("　")).toBe(true);
    expect(isBlankHeader("\t")).toBe(true);
    expect(isBlankHeader("\n")).toBe(true);
    expect(isBlankHeader(null)).toBe(true);
    expect(isBlankHeader(undefined)).toBe(true);
  });

  it("通常の文字列はブランクでない", () => {
    expect(isBlankHeader("住所")).toBe(false);
    expect(isBlankHeader(" 住所 ")).toBe(false);
  });

  it("filterNonBlankHeaders は空ヘッダーを除外", () => {
    expect(filterNonBlankHeaders(["氏名", "", " ", "住所", "\t"])).toEqual([
      "氏名",
      "住所",
    ]);
  });
});
