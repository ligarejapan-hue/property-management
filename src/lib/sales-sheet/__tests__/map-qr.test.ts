/**
 * TDD: 物件の地図QR。
 *   buildMapsSearchUrl: 住所→Googleマップ検索URL。
 *   addMapQrElement: 住所からQRを作り、会社帯右端の枠(CONSUMER_MAP_QR_SLOT)へ配置。
 */
import { describe, it, expect } from "vitest";
import { buildMapsSearchUrl } from "../maps-url";
import { type EditorState, addMapQrElement, MAP_QR_ID } from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type QrElement,
} from "../document-schema";
import { CONSUMER_MAP_QR_SLOT } from "../layout-engine";

function makeState(elements: unknown[]): EditorState {
  const document: SalesSheetDocument = parseSalesSheetDocument({
    page: A4_LANDSCAPE, // 297 x 210
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79", template: "consumer-2026-09" },
    elements,
  });
  return { document, selectedId: null, dirty: false };
}
const qrOf = (s: EditorState) =>
  s.document.elements.find((e): e is QrElement => e.type === "qr");

describe("buildMapsSearchUrl", () => {
  it("住所を Google マップ検索URLへ", () => {
    expect(buildMapsSearchUrl("東京都世田谷区上馬4-36-15")).toBe(
      "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent("東京都世田谷区上馬4-36-15"),
    );
  });
  it("前後空白は trim・記号もエンコード", () => {
    const url = buildMapsSearchUrl("  神奈川県横浜市 A&B 1-2  ");
    expect(url).toContain("query=");
    expect(url).not.toContain(" "); // 生スペースは含まない
    expect(url).toContain(encodeURIComponent("神奈川県横浜市 A&B 1-2"));
  });
  it("空/空白のみは null", () => {
    expect(buildMapsSearchUrl("")).toBeNull();
    expect(buildMapsSearchUrl("   ")).toBeNull();
  });
});

describe("addMapQrElement(会社帯右端の枠)", () => {
  it("住所からQRを作り、枠の位置・大きさで置く(中身=マップURL)", () => {
    const next = addMapQrElement(makeState([]), { address: "東京都練馬区富士見台2-1" });
    const qr = qrOf(next);
    expect(qr).toMatchObject({ id: MAP_QR_ID, ...CONSUMER_MAP_QR_SLOT });
    expect(qr?.content).toBe(buildMapsSearchUrl("東京都練馬区富士見台2-1"));
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("2回目は置き換え(1枚だけ)", () => {
    const once = addMapQrElement(makeState([]), { address: "東京都練馬区" });
    const twice = addMapQrElement(once, { address: "東京都杉並区" });
    expect(twice.document.elements.filter((e) => e.id === MAP_QR_ID)).toHaveLength(1);
  });
  it("住所が空なら何もしない", () => {
    const s = makeState([]);
    expect(addMapQrElement(s, { address: "  " })).toBe(s);
  });
});
