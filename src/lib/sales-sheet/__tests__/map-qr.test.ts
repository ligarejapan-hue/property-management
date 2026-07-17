/**
 * TDD: 物件の地図QR。
 *   buildMapsSearchUrl: 住所→Googleマップ検索URL。
 *   addMapQrElement: 住所からQRを作り、間取図の下(無ければ右下)へ配置。
 */
import { describe, it, expect } from "vitest";
import { buildMapsSearchUrl } from "../maps-url";
import { type EditorState, addMapQrElement } from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type QrElement,
} from "../document-schema";

const SRC = "/uploads/properties/a/1.jpg";
function makeState(elements: unknown[]): EditorState {
  const document: SalesSheetDocument = parseSalesSheetDocument({
    page: A4_LANDSCAPE, // 297 x 210
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
  return { document, selectedId: null, dirty: false };
}
const floorPlan = (over: Record<string, unknown> = {}) => ({
  id: "floor-plan", type: "image", x: 99, y: 46, w: 83, h: 110, z: 1, src: SRC, fit: "contain", ...over,
});
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

describe("addMapQrElement", () => {
  const ADDR = "東京都世田谷区上馬4-36-15";

  it("QR要素を追加し content が地図URL・自動選択・dirty", () => {
    const s = addMapQrElement(makeState([]), { id: "q1", address: ADDR });
    const q = qrOf(s)!;
    expect(q).toBeTruthy();
    expect(q.content).toBe(buildMapsSearchUrl(ADDR));
    expect(q.dataUrl.startsWith("data:image/")).toBe(true);
    expect(s.selectedId).toBe("q1");
    expect(s.dirty).toBe(true);
  });

  // 会社帯/セールスポイントの上端(=写真帯の下端): 210 − (footer24+margin2+salesPoints7+gap4=37) = 173。
  const CONTENT_BOTTOM = 173;
  const fpOf = (s: EditorState) =>
    s.document.elements.find((e) => e.id === "floor-plan")!;

  it("間取図があると(縮めて)その真下・図の幅内に配置し、会社帯を覆わない(@codex #300)", () => {
    const s = addMapQrElement(makeState([floorPlan()]), { id: "q1", address: ADDR });
    const q = qrOf(s)!;
    const fp = fpOf(s); // 結果側(必要なら縮められている)
    expect(q.y).toBeGreaterThanOrEqual(fp.y + fp.h - 0.01); // 図の真下
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // 会社帯を覆わない
    const qCenter = q.x + q.w / 2;
    const fpCenter = fp.x + fp.w / 2;
    expect(Math.abs(qCenter - fpCenter)).toBeLessThan(1); // 図の幅内で中央寄せ
  });

  it("通常生成(図が下端いっぱい)では図を縮めて QR の分を空ける", () => {
    const before = floorPlan({ y: 46, h: 127 }); // 下端=173(通常生成)
    const s = addMapQrElement(makeState([before]), { id: "q1", address: ADDR });
    const fp = fpOf(s);
    expect(fp.h).toBeLessThan(127); // 図が縮む
    const q = qrOf(s)!;
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // QR は会社帯の上
  });

  it("間取図が無ければ右下(ただし会社帯の上)", () => {
    const s = addMapQrElement(makeState([]), { id: "q1", address: ADDR });
    const q = qrOf(s)!;
    expect(q.x + q.w).toBeGreaterThan(297 * 0.6); // 右側
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // 会社帯を覆わない
  });

  it("用紙内にクランプ(負値・はみ出しなし)", () => {
    const s = addMapQrElement(makeState([floorPlan({ y: 46, h: 150 })]), { id: "q1", address: ADDR });
    const q = qrOf(s)!;
    expect(q.x).toBeGreaterThanOrEqual(0);
    expect(q.y).toBeGreaterThanOrEqual(0);
    expect(q.x + q.w).toBeLessThanOrEqual(297 + 0.01);
    expect(q.y + q.h).toBeLessThanOrEqual(210 + 0.01);
  });

  it("住所が空なら no-op(同一参照)", () => {
    const s = makeState([]);
    expect(addMapQrElement(s, { id: "q1", address: "" })).toBe(s);
    expect(addMapQrElement(s, { id: "q1", address: "  " })).toBe(s);
  });

  it("z は最前面・schema 検証を通る", () => {
    const s = addMapQrElement(makeState([floorPlan()]), { id: "q1", address: ADDR });
    const q = qrOf(s)!;
    expect(q.z).toBeGreaterThanOrEqual(2);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });
});
