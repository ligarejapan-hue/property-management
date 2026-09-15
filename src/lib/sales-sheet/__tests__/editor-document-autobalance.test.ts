import { describe, it, expect } from "vitest";
import { type EditorState, autoBalanceLayout } from "../editor-document";
import { buildSaleHouseDocument } from "../build-document";
import { computeConsumerLayout, CONSUMER_PHOTO_ZONE, CONSUMER_MAP_QR_SLOT } from "../layout-engine";
import { salesSheetDocumentSchema, A4_PORTRAIT, type SalesSheetElement } from "../document-schema";

const houseDoc = () => buildSaleHouseDocument({
  property: { address: "東京都杉並区西荻北1-4-3", layoutType: "3LDK", buildingCoverageRatio: "60", floorAreaRatio: "200", roadType: "公道", roadWidth: "4.0" },
  photos: [{ fileUrl: "/uploads/1.jpg" }, { fileUrl: "/uploads/2.jpg" }],
  floorPlanImage: { fileUrl: "/uploads/plan.png" },
  overrides: { access: "徒歩6分", remarks: "南向き" },
});
const stateOf = (document = houseDoc()): EditorState => ({ document, selectedId: null, dirty: false });
const byId = (s: EditorState, id: string) => s.document.elements.find((e) => e.id === id) as SalesSheetElement;
const moved = (s: EditorState, id: string, dx: number): EditorState => ({
  ...s,
  document: { ...s.document, elements: s.document.elements.map((e) => (e.id === id ? { ...e, x: e.x + dx } : e)) },
});

describe("autoBalanceLayout(新ひな型)", () => {
  it("作成直後の図面は同一参照(バランス済み)", () => {
    const s = stateOf();
    expect(autoBalanceLayout(s)).toBe(s);
  });
  it("手で動かした定型項目・表・写真を標準の位置へ戻す", () => {
    const s0 = stateOf();
    const s = ["heading", "overview", "overview-detail-b", "sales-points-band", "photo-1", "floor-plan"].reduce((acc, id) => moved(acc, id, 3), s0);
    const next = autoBalanceLayout(s);
    for (const id of ["heading", "overview", "overview-detail-b", "sales-points-band", "photo-1", "floor-plan"]) {
      expect(byId(next, id)).toMatchObject({ x: byId(s0, id).x, y: byId(s0, id).y, w: byId(s0, id).w, h: byId(s0, id).h });
    }
    expect(next.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("表の行数が変わったら文字サイズを計算し直す", () => {
    const s0 = stateOf();
    const rows = Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const s: EditorState = { ...s0, document: { ...s0.document, elements: s0.document.elements.map((e) =>
      e.type === "table" && (e.id === "overview-detail-a" || e.id === "overview-detail-b") ? { ...e, rows } : e) } };
    const next = autoBalanceLayout(s);
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 26 });
    expect(byId(next, "overview-detail-a")).toMatchObject({ style: { fontSizePt: L.detailFontSizePt } });
    expect(byId(next, "overview")).toMatchObject({ style: { fontSizePt: L.mainTable.fontSizePt } });
  });
  it("地図QRは枠へ戻し、利用者が足した文字と会社帯は動かさない", () => {
    const s0 = stateOf();
    const extra = { id: "my-note", type: "text" as const, x: 150, y: 150, w: 30, h: 8, z: 5, content: "メモ", style: {} };
    const qr = { id: "map-qr", type: "qr" as const, x: 10, y: 10, w: 20, h: 20, z: 6, dataUrl: "data:image/png;base64,AAAA" };
    const s = moved({ ...s0, document: { ...s0.document, elements: [...s0.document.elements, extra, qr] } }, "footer-name-ja", 2);
    const next = autoBalanceLayout(s);
    expect(byId(next, "map-qr")).toMatchObject(CONSUMER_MAP_QR_SLOT);
    expect(byId(next, "my-note")).toBe(byId(s, "my-note"));
    expect(byId(next, "footer-name-ja")).toBe(byId(s, "footer-name-ja"));
  });
  it("写真と間取り図は写真枠の中", () => {
    const next = autoBalanceLayout(moved(stateOf(), "photo-2", 100));
    for (const e of next.document.elements.filter((el) => el.type === "image")) {
      expect(e.x + e.w).toBeLessThanOrEqual(CONSUMER_PHOTO_ZONE.x + CONSUMER_PHOTO_ZONE.w + 1e-6);
    }
  });
  it("A4縦では何もしない", () => {
    const s0 = stateOf();
    const s: EditorState = { ...s0, document: { ...s0.document, page: A4_PORTRAIT } };
    expect(autoBalanceLayout(s)).toBe(s);
  });
});
