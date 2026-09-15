import { describe, it, expect } from "vitest";
import { buildSpecSheetDocument, type SpecSheetParts } from "../build-document";
import { salesSheetDocumentSchema, isConsumerTemplate, type SalesSheetElement } from "../document-schema";
import { computeConsumerLayout, CONSUMER_PHOTO_ZONE, type Rect } from "../layout-engine";
import { buildConsumerFooterBand } from "../footer-band";
import { CONSUMER_FONT_FAMILY } from "../consumer-theme";

const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ label: `${prefix}${i + 1}`, value: `値${i + 1}` }));
const base: SpecSheetParts = {
  heading: "練馬区富士見台二丁目 中古戸建",
  priceText: "6980万円",
  kindLabel: "中古戸建",
  mainRows: rows("主要", 8),
  detailRows: rows("詳細", 5),
};
const byId = (els: SalesSheetElement[], id: string) => els.find((e) => e.id === id);
const geom = (r: Rect) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
const inside = (outer: Rect, r: Rect) => r.x >= outer.x - 1e-6 && r.y >= outer.y - 1e-6 && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("buildSpecSheetDocument(消費者向けひな型)", () => {
  it("theme に目印・書体・紺を入れる", () => {
    const doc = buildSpecSheetDocument(base);
    expect(isConsumerTemplate(doc)).toBe(true);
    expect(doc.theme).toEqual({ fontFamily: CONSUMER_FONT_FAMILY, accentColor: "#1f3a5f", template: "consumer-2026-09" });
  });

  it("各要素が computeConsumerLayout の位置に置かれる", () => {
    const doc = buildSpecSheetDocument(base);
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 5 });
    const expected: [string, Rect][] = [
      ["catch-band", L.catchBand], ["catch-copy", L.catchCopy], ["kind-tag", L.kindTag], ["heading", L.heading],
      ["price", L.price], ["overview", L.mainTable], ["overview-detail-a", L.detailLeft], ["overview-detail-b", L.detailRight],
      ["sales-points-band", L.salesPointsBand], ["sales-points", L.salesPoints],
    ];
    for (const [id, r] of expected) expect(byId(doc.elements, id)).toMatchObject(geom(r));
    expect(byId(doc.elements, "overview")).toMatchObject({ style: { fontSizePt: L.mainTable.fontSizePt } });
    expect(byId(doc.elements, "overview-detail-a")).toMatchObject({ style: { fontSizePt: L.detailFontSizePt } });
  });

  it("文字と色(紺帯・白いキャッチ・赤い価格・物件種目)", () => {
    const doc = buildSpecSheetDocument({ ...base, catchCopy: "駅徒歩6分" });
    expect(byId(doc.elements, "catch-band")).toMatchObject({ type: "shape", fill: "#1f3a5f" });
    expect(byId(doc.elements, "catch-copy")).toMatchObject({ content: "駅徒歩6分", style: { fontSizePt: 16, bold: true, color: "#ffffff" } });
    expect(byId(doc.elements, "kind-tag")).toMatchObject({ content: "中古戸建", style: { color: "#ffffff", align: "right" } });
    expect(byId(doc.elements, "heading")).toMatchObject({ style: { fontSizePt: 14, bold: true, color: "#1f3a5f" } });
    expect(byId(doc.elements, "price")).toMatchObject({ content: "6980万円", style: { fontSizePt: 32, bold: true, color: "#b7281e" } });
  });

  it("主要表=8行・線なし・1行おき淡紺 / 詳細表=左右に分割・線なし・色なし", () => {
    const doc = buildSpecSheetDocument(base);
    expect(byId(doc.elements, "overview")).toMatchObject({ rows: base.mainRows, style: { borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 } });
    const a = byId(doc.elements, "overview-detail-a");
    const b = byId(doc.elements, "overview-detail-b");
    expect(a).toMatchObject({ rows: base.detailRows.slice(0, 3), style: { borderless: true, cellPaddingMm: 0.8 } });
    expect(b).toMatchObject({ rows: base.detailRows.slice(3) });
    expect(a?.type === "table" && a.style.stripeColor).toBeFalsy();
  });

  it("ポイントは見出し付きで最大3つ・無ければ空", () => {
    const doc = buildSpecSheetDocument({ ...base, salesPoints: ["南向き", " ", "外壁塗装済", "学校近い", "4つ目"] });
    expect(byId(doc.elements, "sales-points")).toMatchObject({ content: "おすすめポイント　◆南向き　◆外壁塗装済　◆学校近い" });
    expect(byId(buildSpecSheetDocument(base).elements, "sales-points")).toMatchObject({ content: "" });
    expect(byId(doc.elements, "sales-points-band")).toMatchObject({ type: "shape", fill: "#eef2f7" });
  });

  it("会社帯は buildConsumerFooterBand と同じ", () => {
    const footer = { transactionType: "専任媒介", staff: "山田" };
    const doc = buildSpecSheetDocument({ ...base, footer });
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 5 });
    for (const el of buildConsumerFooterBand(L.footer, footer)) expect(byId(doc.elements, el.id)).toEqual(el);
  });

  for (const photoCount of [0, 1, 3]) {
    for (const withPlan of [false, true]) {
      it(`写真${photoCount}枚・間取り図${withPlan ? "あり" : "なし"}: 写真枠内・重ならない・並び順`, () => {
        const doc = buildSpecSheetDocument({
          ...base,
          photos: Array.from({ length: photoCount }, (_, i) => ({ fileUrl: `/uploads/p${i}.jpg` })),
          floorPlanImage: withPlan ? { fileUrl: "/uploads/plan.png" } : null,
        });
        const images = doc.elements.filter((e) => e.type === "image");
        const expectedIds = Array.from({ length: photoCount }, (_, i) => `photo-${i + 1}`);
        if (withPlan) expectedIds.splice(Math.min(1, expectedIds.length), 0, "floor-plan");
        expect(images.map((e) => e.id)).toEqual(expectedIds);
        for (const img of images) {
          expect(inside(CONSUMER_PHOTO_ZONE, img)).toBe(true);
          expect(img.type === "image" && img.fit).toBe("contain");
        }
        for (let i = 0; i < images.length; i++) for (let j = i + 1; j < images.length; j++) expect(overlaps(images[i], images[j])).toBe(false);
        expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
      });
    }
  }

  for (const n of [0, 12, 26]) {
    it(`詳細${n}行でも保存できる(schema)`, () => {
      expect(salesSheetDocumentSchema.safeParse(buildSpecSheetDocument({ ...base, detailRows: rows("詳細", n) })).success).toBe(true);
    });
  }
});
