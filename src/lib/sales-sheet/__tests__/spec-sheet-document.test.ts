import { describe, it, expect } from "vitest";
import { buildSpecSheetDocument, type SpecSheetParts } from "../build-document";
import { salesSheetDocumentSchema } from "../document-schema";

const findEl = (doc: { elements: unknown[] }, id: string) =>
  (doc.elements as { id: string }[]).find((e) => e.id === id);

const tableLabels = (doc: { elements: unknown[] }): string[] => {
  for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
    if (el.type === "table") return (el.rows ?? []).map((row) => row.label);
  }
  return [];
};

const imageCount = (doc: { elements: { type: string }[] }) =>
  doc.elements.filter((e) => e.type === "image").length;

const baseParts: SpecSheetParts = {
  heading: "西荻リリエンハイム　4号室",
  priceText: "6590万円",
  rows: [
    { label: "所在地", value: "東京都杉並区西荻北1-4-3" },
    { label: "用途地域", value: "第一種中高層住居専用地域" },
  ],
};

describe("buildSpecSheetDocument（種別非依存の自社マイソク版面レイアウト・[F2-A Task1]）", () => {
  it("与えた rows がそのままスペック表(overview)要素に入る", () => {
    const doc = buildSpecSheetDocument(baseParts);
    const labels = tableLabels(doc);
    expect(labels).toEqual(["所在地", "用途地域"]);
    expect(findEl(doc, "overview")).toMatchObject({
      type: "table",
      x: 150,
      y: 26,
      w: 137,
      h: 167,
      z: 1,
      rows: baseParts.rows,
      style: { fontSizePt: 7, borderColor: "#cccccc", labelColor: "#15324f" },
    });
  });

  it("catchCopy が空('') でも catch-band(shape) と catch-copy(text) 要素は常に出る", () => {
    const doc = buildSpecSheetDocument({ ...baseParts, catchCopy: undefined });
    expect(findEl(doc, "catch-band")).toMatchObject({
      type: "shape",
      x: 10,
      y: 8,
      w: 277,
      h: 16,
      z: 1,
      shape: "rect",
      fill: "#15324f",
    });
    expect(findEl(doc, "catch-copy")).toMatchObject({
      type: "text",
      x: 16,
      y: 8,
      w: 265,
      h: 16,
      z: 2,
      content: "",
      style: { fontSizePt: 13, bold: true, color: "#ffffff", align: "center" },
    });
  });

  it("catchCopy を渡すと catch-copy 要素の content に反映される", () => {
    const doc = buildSpecSheetDocument({ ...baseParts, catchCopy: "北東角部屋" });
    expect(findEl(doc, "catch-copy")).toMatchObject({ content: "北東角部屋" });
  });

  it("heading/priceText が heading/price 要素にそのまま入る", () => {
    const doc = buildSpecSheetDocument(baseParts);
    expect(findEl(doc, "heading")).toMatchObject({
      type: "text",
      x: 10,
      y: 26,
      w: 94,
      h: 7,
      z: 2,
      content: "西荻リリエンハイム　4号室",
      style: { fontSizePt: 11, bold: true, color: "#15324f" },
    });
    expect(findEl(doc, "price")).toMatchObject({
      type: "text",
      x: 10,
      y: 33,
      w: 94,
      h: 12,
      z: 2,
      content: "6590万円",
      style: { fontSizePt: 20, bold: true, color: "#d0331a" },
    });
  });

  it("priceText が空文字でも price 要素は出る(contentが空)", () => {
    const doc = buildSpecSheetDocument({ ...baseParts, priceText: "" });
    expect(findEl(doc, "price")).toMatchObject({ type: "text", content: "" });
  });

  it("salesPoints は ◆ 区切りで結合して sales-points 要素に入る(未指定なら空文字)", () => {
    const withPoints = buildSpecSheetDocument({
      ...baseParts,
      salesPoints: ["リノベ済", "南向き", "即入居可"],
    });
    expect(findEl(withPoints, "sales-points")).toMatchObject({
      type: "text",
      x: 10,
      y: 187,
      w: 136,
      h: 7,
      z: 2,
      content: "◆リノベ済　◆南向き　◆即入居可",
      style: { fontSizePt: 9, bold: true, color: "#15324f" },
    });

    const withoutPoints = buildSpecSheetDocument(baseParts);
    expect(findEl(withoutPoints, "sales-points")).toMatchObject({ content: "" });
  });

  it("salesPoints の前後空白はtrimされ、空要素は落ちる", () => {
    const doc = buildSpecSheetDocument({
      ...baseParts,
      salesPoints: ["  リノベ済  ", "", "   ", "南向き"],
    });
    expect(findEl(doc, "sales-points")).toMatchObject({ content: "◆リノベ済　◆南向き" });
  });

  it("company は会社定数、company-details は footerDetails(未指定なら空文字)が入る", () => {
    const doc = buildSpecSheetDocument({ ...baseParts, footerDetails: "取引態様：専任媒介" });
    expect(findEl(doc, "company")).toMatchObject({
      type: "text",
      x: 10,
      y: 195,
      w: 277,
      h: 6,
      z: 2,
      content: "株式会社リガーレジャパン Ligare Japan　TEL 03-6823-2760",
      style: { fontSizePt: 9, color: "#15324f" },
    });
    expect(findEl(doc, "company-details")).toMatchObject({
      type: "text",
      x: 10,
      y: 201,
      w: 277,
      h: 7,
      z: 2,
      content: "取引態様：専任媒介",
      style: { fontSizePt: 8, color: "#15324f" },
    });

    const withoutFooter = buildSpecSheetDocument(baseParts);
    expect(findEl(withoutFooter, "company-details")).toMatchObject({ content: "" });
  });

  it("floorPlanImage を指定したときのみ floor-plan の image 要素が追加される", () => {
    const withPlan = buildSpecSheetDocument({
      ...baseParts,
      floorPlanImage: { fileUrl: "/uploads/plan.jpg" },
    });
    expect(findEl(withPlan, "floor-plan")).toMatchObject({
      type: "image",
      x: 108,
      y: 26,
      w: 32,
      h: 18,
      z: 1,
      src: "/uploads/plan.jpg",
      fit: "contain",
      alt: "間取り図",
    });

    const withoutPlan = buildSpecSheetDocument(baseParts);
    expect(findEl(withoutPlan, "floor-plan")).toBeUndefined();

    const withNullPlan = buildSpecSheetDocument({ ...baseParts, floorPlanImage: null });
    expect(findEl(withNullPlan, "floor-plan")).toBeUndefined();
  });

  it("photos を渡すと写真枚数分の image 要素が追加される(0〜3枚)", () => {
    const photos3 = [
      { fileUrl: "/uploads/1.jpg" },
      { fileUrl: "/uploads/2.jpg" },
      { fileUrl: "/uploads/3.jpg" },
    ];
    expect(imageCount(buildSpecSheetDocument({ ...baseParts, photos: photos3 }))).toBe(3);
    expect(imageCount(buildSpecSheetDocument({ ...baseParts, photos: [] }))).toBe(0);
    expect(imageCount(buildSpecSheetDocument(baseParts))).toBe(0);
  });

  it("A4横で schema 検証を通る（保存可能な document）", () => {
    const doc = buildSpecSheetDocument({
      ...baseParts,
      catchCopy: "駅近角部屋",
      salesPoints: ["リノベ済", "南向き"],
      footerDetails: "取引態様：専任媒介",
      photos: [{ fileUrl: "/uploads/1.jpg" }],
      floorPlanImage: { fileUrl: "/uploads/plan.jpg" },
    });
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
