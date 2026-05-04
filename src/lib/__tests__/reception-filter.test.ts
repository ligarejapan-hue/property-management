import { describe, it, expect } from "vitest";
import {
  parseReceptionRows,
  applyReceptionFilters,
  isReceptionDlMarked,
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
