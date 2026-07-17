/**
 * TDD: 物件の地図QR。
 *   buildMapsSearchUrl: 住所→Googleマップ検索URL。
 *   addMapQrElement: 住所からQRを作り、間取図の下(無ければ右下)へ配置。
 */
import { describe, it, expect } from "vitest";
import { buildMapsSearchUrl } from "../maps-url";
import {
  type EditorState,
  addMapQrElement,
  autoBalanceLayout,
  setAsFloorPlan,
  unsetFloorPlan,
  deleteMapQr,
  MAP_QR_ID,
} from "../editor-document";
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
    const s = addMapQrElement(makeState([]), { address: ADDR });
    const q = qrOf(s)!;
    expect(q).toBeTruthy();
    expect(q.content).toBe(buildMapsSearchUrl(ADDR));
    expect(q.dataUrl.startsWith("data:image/")).toBe(true);
    expect(q.id).toBe(MAP_QR_ID); // 地図QRは単一(id固定)
    expect(s.selectedId).toBe(MAP_QR_ID);
    expect(s.dirty).toBe(true);
  });

  it("地図QRは1枚(再追加で置き換え)", () => {
    const once = addMapQrElement(makeState([floorPlan()]), { address: ADDR });
    const twice = addMapQrElement(once, { address: ADDR });
    expect(twice.document.elements.filter((e) => e.id === MAP_QR_ID)).toHaveLength(1);
  });

  // 会社帯/セールスポイントの上端(=写真帯の下端): 210 − (footer24+margin2+salesPoints7+gap4=37) = 173。
  const CONTENT_BOTTOM = 173;
  const fpOf = (s: EditorState) =>
    s.document.elements.find((e) => e.id === "floor-plan")!;

  it("間取図があると(縮めて)その真下・図の幅内に配置し、会社帯を覆わない(@codex #300)", () => {
    const s = addMapQrElement(makeState([floorPlan()]), { address: ADDR });
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
    const s = addMapQrElement(makeState([before]), { address: ADDR });
    const fp = fpOf(s);
    expect(fp.h).toBeLessThan(127); // 図が縮む
    const q = qrOf(s)!;
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // QR は会社帯の上
  });

  it("間取図が無ければ概要表の左・会社帯の上(概要表を覆わない・@codex #300 P1)", () => {
    const overview = { id: "overview", type: "table", x: 188, y: 26, w: 99, h: 158, z: 1, rows: [{ label: "a", value: "b" }], style: {} };
    const s = addMapQrElement(makeState([overview]), { address: ADDR });
    const q = qrOf(s)!;
    expect(q.x + q.w).toBeLessThanOrEqual(188 + 0.5); // 概要表(x=188)の左に収まる
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // 会社帯も覆わない
  });

  it("地図QRを削除すると縮めた間取図が全高へ戻る(@codex #300)", () => {
    const s0 = makeState([floorPlan({ y: 46, h: 127 })]); // 全高相当
    const s1 = addMapQrElement(s0, { address: ADDR }); // 図が縮む
    expect(fpOf(s1).h).toBeLessThan(127);
    const s2 = deleteMapQr(s1);
    expect(s2.document.elements.some((e) => e.id === MAP_QR_ID)).toBe(false);
    expect(fpOf(s2).h).toBeGreaterThan(fpOf(s1).h); // 全高へ戻る(空白解消)
    expect(fpOf(s2).y + fpOf(s2).h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5);
  });

  it("用紙内にクランプ(負値・はみ出しなし)", () => {
    const s = addMapQrElement(makeState([floorPlan({ y: 46, h: 150 })]), { address: ADDR });
    const q = qrOf(s)!;
    expect(q.x).toBeGreaterThanOrEqual(0);
    expect(q.y).toBeGreaterThanOrEqual(0);
    expect(q.x + q.w).toBeLessThanOrEqual(297 + 0.01);
    expect(q.y + q.h).toBeLessThanOrEqual(210 + 0.01);
  });

  it("住所が空なら no-op(同一参照)", () => {
    const s = makeState([]);
    expect(addMapQrElement(s, { address: "" })).toBe(s);
    expect(addMapQrElement(s, { address: "  " })).toBe(s);
  });

  it("長い住所(建物名込み)でも QR を生成できる(@codex #300: 適応セルサイズ)", () => {
    // マンション名込みの長い住所。従来は QR data URL 上限超過で無反応だった。
    const longAddr = "北海道札幌市中央区北一条西二十三丁目四番五号サンハイツ札幌マンション303号室";
    const s = addMapQrElement(makeState([]), { address: longAddr });
    const q = qrOf(s);
    expect(q).toBeTruthy(); // no-op でなく QR が入る
    expect(q!.dataUrl.startsWith("data:image/")).toBe(true);
  });

  it("間取図が低すぎると図を上へ寄せ、QR は図の真下・会社帯の上に置く(@codex #300)", () => {
    const s = addMapQrElement(makeState([floorPlan({ y: 150, h: 20 })]), { address: ADDR });
    const q = qrOf(s)!;
    const fp = fpOf(s);
    expect(q.y).toBeGreaterThanOrEqual(fp.y + fp.h - 0.5); // QR は図の真下(図の上へ回り込まない)
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // 会社帯も覆わない
  });

  it("z は最前面・schema 検証を通る", () => {
    const s = addMapQrElement(makeState([floorPlan()]), { address: ADDR });
    const q = qrOf(s)!;
    expect(q.z).toBeGreaterThanOrEqual(2);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });
});

describe("addMapQrElement × autoBalanceLayout（予約の保持・@codex #300）", () => {
  const ADDR = "東京都世田谷区上馬4-36-15";
  const CONTENT_BOTTOM = 173;
  const overviewEl = () => ({
    id: "overview", type: "table", x: 188, y: 26, w: 99, h: 158, z: 1,
    rows: [{ label: "物件種別", value: "売地" }], style: {},
  });
  const img = (n: number) => ({
    id: `img-${n}`, type: "image", x: 103, y: 75, w: 90, h: 60, z: n, src: SRC, fit: "cover",
  });

  it("レイアウト自動調整でも間取図が地図QRを覆わない(図を縮めて真下を保つ)", () => {
    // 間取図(1枚) + 写真 + 概要表 + 地図QR。自動調整で図が全高に戻っても QR を覆わない。
    const withFp = { id: "floor-plan", type: "image", x: 99, y: 46, w: 83, h: 110, z: 1, src: SRC, fit: "contain" };
    const s0 = makeState([withFp, img(2), img(3), overviewEl()]);
    const s1 = addMapQrElement(s0, { address: ADDR });
    const s2 = autoBalanceLayout(s1);
    const fp = s2.document.elements.find((e) => e.id === "floor-plan")!;
    const q = s2.document.elements.find((e): e is QrElement => e.id === MAP_QR_ID)!;
    expect(q.y).toBeGreaterThanOrEqual(fp.y + fp.h - 0.5); // 図の真下(覆っていない)
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // 会社帯も覆わない
  });

  it("図なしで追加した地図QRは、後で間取図を指定すると図の真下へ再確保(setAsFloorPlan)", () => {
    const s0 = makeState([img(2), img(3), overviewEl()]); // 図なし
    const s1 = addMapQrElement(s0, { address: ADDR }); // 右下に地図QR
    const s2 = setAsFloorPlan(s1, "img-2", "demoted-x"); // 写真を間取図に
    const fp = s2.document.elements.find((e) => e.id === "floor-plan")!;
    const q = s2.document.elements.find((e): e is QrElement => e.id === MAP_QR_ID)!;
    expect(q.y).toBeGreaterThanOrEqual(fp.y + fp.h - 0.5); // 新しい図の真下へ移動
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5);
  });

  it("間取図を解除すると地図QRは右下フォールバックへ戻る(unsetFloorPlan・@codex #300)", () => {
    const withFp = { id: "floor-plan", type: "image", x: 99, y: 46, w: 83, h: 110, z: 1, src: SRC, fit: "contain" };
    const s0 = makeState([withFp, img(2), overviewEl()]);
    const s1 = addMapQrElement(s0, { address: ADDR }); // 図の真下
    const s2 = unsetFloorPlan(s1, "back-to-photo"); // 図を解除
    expect(s2.document.elements.some((e) => e.id === "floor-plan")).toBe(false);
    const q = s2.document.elements.find((e): e is QrElement => e.id === MAP_QR_ID)!;
    expect(q.x + q.w).toBeGreaterThan(297 * 0.6); // 右下フォールバック
    expect(q.y + q.h).toBeLessThanOrEqual(CONTENT_BOTTOM + 0.5); // 会社帯の上
  });
});
