/**
 * 物件の画面のファイルを入れる枠を1つにする(2026-10-28 発注者決定)— 入れたファイルの行き先(純関数)。
 *   画像 → 写真か書類かを選ぶ(既定=写真・発注者決定③)
 *   PDF  → 中身を見て、まとめてあるなら分け方の確認・謄本なら謄本・ほかは通常の添付
 */
import { describe, it, expect } from "vitest";
import { dropKindOf, routeForAnalysis, segmentKindLabel, splitDrop } from "../unified-drop";

const f = (name: string, type = "") => ({ name, type });

describe("dropKindOf", () => {
  it.each([
    [f("a.jpg", "image/jpeg"), "image"],
    [f("a.HEIC"), "image"],
    [f("a.webp", ""), "image"],
    [f("a.pdf", "application/pdf"), "pdf"],
    [f("a.PDF", ""), "pdf"],
    [f("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "other"],
    [f("a.csv", "text/csv"), "other"],
  ])("%o → %s", (file, kind) => {
    expect(dropKindOf(file)).toBe(kind);
  });
});

describe("splitDrop", () => {
  it("画像とそれ以外に分け、並びは入れた順のまま", () => {
    const files = [f("1.pdf"), f("2.jpg"), f("3.xlsx"), f("4.png")];
    expect(splitDrop(files)).toEqual({ images: [files[1], files[3]], rest: [files[0], files[2]] });
  });
});

describe("routeForAnalysis", () => {
  it("2つ以上に分かれる → 分け方の確認", () => {
    expect(
      routeForAnalysis({ pageCount: 3, tooManyPages: false, segments: [{ from: 1, to: 1, kind: "drawings" }, { from: 2, to: 3, kind: "registry" }] }),
    ).toBe("split");
  });

  it("全部が謄本 → 謄本として保存", () => {
    expect(routeForAnalysis({ pageCount: 2, tooManyPages: false, segments: [{ from: 1, to: 2, kind: "registry" }] })).toBe("registry");
  });

  it("1つの書類 → いつもどおり保存", () => {
    expect(routeForAnalysis({ pageCount: 2, tooManyPages: false, segments: [{ from: 1, to: 2, kind: "drawings" }] })).toBe("general");
  });

  it("ページが多すぎる → いつもどおり保存(分けない)", () => {
    expect(routeForAnalysis({ pageCount: 99, tooManyPages: true, segments: [{ from: 1, to: 99, kind: null }] })).toBe("general");
  });

  it("⚠中身を見られなかった(謄本かもしれない)→ 推測せず聞く", () => {
    expect(routeForAnalysis(null)).toBe("ask");
    expect(routeForAnalysis({ pageCount: null, tooManyPages: false, segments: [] })).toBe("ask");
    // 文字の無いページを読み取れず、1つの書類としか分からなかった
    expect(
      routeForAnalysis({ pageCount: 3, tooManyPages: false, ocr: "unavailable", segments: [{ from: 1, to: 3, kind: null }] }),
    ).toBe("ask");
    expect(
      routeForAnalysis({ pageCount: 3, tooManyPages: false, ocr: "failed", segments: [{ from: 1, to: 3, kind: "drawings" }] }),
    ).toBe("ask");
  });

  it("読み取りが済んで1つの書類と分かったものは聞かない", () => {
    expect(
      routeForAnalysis({ pageCount: 3, tooManyPages: false, ocr: "done", segments: [{ from: 1, to: 3, kind: null }] }),
    ).toBe("general");
  });
});

describe("segmentKindLabel", () => {
  it("種類の名前・謄本・その他", () => {
    expect(segmentKindLabel("property_summary")).toBe("物件概要書");
    expect(segmentKindLabel("registry")).toBe("謄本");
    expect(segmentKindLabel(null)).toBe("その他");
    expect(segmentKindLabel("nope")).toBe("その他");
  });
});
