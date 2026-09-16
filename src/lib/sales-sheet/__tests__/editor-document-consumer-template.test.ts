import { describe, it, expect } from "vitest";
import {
  type EditorState, autoArrangePhotos, autoBalanceLayout, addMapQrElement, editFooterData,
  setAsFloorPlan, MAP_QR_ID,
} from "../editor-document";
import { parseSalesSheetDocument, A4_LANDSCAPE } from "../document-schema";
import { CONSUMER_PHOTO_ZONE, CONSUMER_MAP_QR_SLOT, CONSUMER_FOOTER } from "../layout-engine";
import { buildConsumerFooterBand, readFooterData } from "../footer-band";

const SRC = "/uploads/properties/a/1.jpg";
function makeState(elements: unknown[], template: boolean = true): EditorState {
  const document = parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f3a5f", ...(template ? { template: "consumer-2026-09" } : {}) },
    elements,
  });
  return { document, selectedId: null, dirty: false };
}
const img = (n: number, over: Record<string, unknown> = {}) => ({
  id: `img-${n}`, type: "image", x: 140, y: 60, w: 90, h: 60, z: n, src: SRC, fit: "cover", ...over,
});
const insideZone = (r: { x: number; y: number; w: number; h: number }) =>
  r.x >= CONSUMER_PHOTO_ZONE.x - 1e-6 && r.y >= CONSUMER_PHOTO_ZONE.y - 1e-6 &&
  r.x + r.w <= CONSUMER_PHOTO_ZONE.x + CONSUMER_PHOTO_ZONE.w + 1e-6 && r.y + r.h <= CONSUMER_PHOTO_ZONE.y + CONSUMER_PHOTO_ZONE.h + 1e-6;

describe("旧ひな型(theme.template なし)では自動機能が何も変えない", () => {
  const legacy = () => makeState([img(1), img(2), { id: "overview", type: "table", x: 188, y: 26, w: 99, h: 150, z: 1, rows: [], style: {} }], false);
  it("autoArrangePhotos", () => { const s = legacy(); expect(autoArrangePhotos(s)).toBe(s); });
  it("autoBalanceLayout", () => { const s = legacy(); expect(autoBalanceLayout(s)).toBe(s); });
  it("addMapQrElement", () => { const s = legacy(); expect(addMapQrElement(s, { address: "東京都練馬区" })).toBe(s); });
  it("editFooterData", () => {
    const s = makeState(buildConsumerFooterBand(CONSUMER_FOOTER, { transactionType: "仲介" }), false);
    expect(editFooterData(s, { transactionType: "専任" })).toBe(s);
  });
  it("setAsFloorPlan は id を付け替えるが並べ直さない", () => {
    const s = legacy();
    const next = setAsFloorPlan({ ...s, selectedId: "img-1" }, "img-1", "demoted");
    const fp = next.document.elements.find((e) => e.id === "floor-plan");
    expect(fp).toMatchObject({ x: 140, y: 60, w: 90, h: 60 });
  });
});

describe("新ひな型", () => {
  it("autoArrangePhotos: 間取り図も写真枠に並ぶ・重ならない", () => {
    const s = makeState([img(1), { ...img(2), id: "floor-plan" }, img(3)]);
    const next = autoArrangePhotos(s, { aspects: { "img-1": 1.5, "floor-plan": 1, "img-3": 0.75 } });
    const images = next.document.elements.filter((e) => e.type === "image");
    expect(images).toHaveLength(3);
    for (const r of images) expect(insideZone(r)).toBe(true);
    expect(next.document.elements.find((e) => e.id === "floor-plan")?.type === "image").toBe(true);
    expect(autoArrangePhotos(next, { aspects: { "img-1": 1.5, "floor-plan": 1, "img-3": 0.75 } })).toBe(next);
  });
  it("addMapQrElement: 会社帯右端の枠に置き、写真は動かさない", () => {
    const s = makeState([img(1)]);
    const next = addMapQrElement(s, { address: "東京都練馬区富士見台2-1" });
    expect(next.document.elements.find((e) => e.id === MAP_QR_ID)).toMatchObject({ type: "qr", ...CONSUMER_MAP_QR_SLOT });
    expect(next.document.elements.find((e) => e.id === "img-1")).toEqual(s.document.elements[0]);
    expect(next.selectedId).toBe(MAP_QR_ID);
  });
  it("editFooterData: 取引表だけ作り直し、6値を読み戻せる", () => {
    const s = makeState(buildConsumerFooterBand(CONSUMER_FOOTER, { transactionType: "仲介" }));
    const next = editFooterData(s, { transactionType: "専任", staff: "山田" });
    expect(readFooterData(next.document.elements)).toMatchObject({ transactionType: "専任", staff: "山田" });
    expect(next.document.elements.find((e) => e.id === "footer-staff-table")).toMatchObject({ style: { borderless: true } });
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });
});
