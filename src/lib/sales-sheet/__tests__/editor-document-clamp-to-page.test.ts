/**
 * TDD: clampElementsToPage — 用紙外にはみ出した要素を用紙内へ引き戻す修復。
 * 保存境界(assertSavableDocument)は ±10000mm 許容でページ外要素を保存できてしまうため、
 * 図面を開いた時に「見えない/用紙外の要素」を用紙内へ戻して選択・編集可能にする。
 */
import { describe, it, expect } from "vitest";
import { type EditorState, clampElementsToPage } from "../editor-document";
import {
  parseSalesSheetDocument,
  A4_LANDSCAPE,
  type SalesSheetDocument,
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
const imageEl = (n: number, over: Record<string, unknown> = {}) => ({
  id: `img-${n}`, type: "image", x: 10, y: 10, w: 90, h: 60, z: n, src: SRC, fit: "cover", ...over,
});
const byId = (s: EditorState, id: string) => s.document.elements.find((e) => e.id === id)!;

describe("clampElementsToPage", () => {
  it("すべて用紙内なら no-op(同一参照)", () => {
    const s = makeState([imageEl(1), imageEl(2, { x: 100, y: 100 })]);
    expect(clampElementsToPage(s)).toBe(s);
  });

  it("用紙下端の外(y≥210)にある要素を用紙内へ引き戻す", () => {
    const s = makeState([imageEl(1, { x: 0, y: 230, w: 120, h: 40 })]);
    const out = clampElementsToPage(s);
    expect(out).not.toBe(s);
    const el = byId(out, "img-1");
    // 下端が用紙内: y ≤ 210 − 40 = 170。
    expect(el.y).toBeCloseTo(170, 6);
    expect(el.x).toBe(0);
    expect(el.w).toBe(120); // サイズは変えない
    expect(el.h).toBe(40);
    expect(out.dirty).toBe(true);
  });

  it("用紙右端の外(x+w>297)にある要素を用紙内へ引き戻す", () => {
    const s = makeState([imageEl(1, { x: 260, y: 10, w: 90, h: 60 })]);
    const el = byId(clampElementsToPage(s), "img-1");
    expect(el.x).toBeCloseTo(207, 6); // 297 − 90
    expect(el.y).toBe(10);
  });

  it("負座標(用紙の左/上の外)を 0 へ引き戻す", () => {
    const s = makeState([imageEl(1, { x: -30, y: -20, w: 90, h: 60 })]);
    const el = byId(clampElementsToPage(s), "img-1");
    expect(el.x).toBe(0);
    expect(el.y).toBe(0);
  });

  it("用紙より大きい要素は左上(0,0)に寄せる(サイズは保持)", () => {
    const s = makeState([imageEl(1, { x: 400, y: 400, w: 320, h: 240 })]);
    const el = byId(clampElementsToPage(s), "img-1");
    expect(el.x).toBe(0);
    expect(el.y).toBe(0);
    expect(el.w).toBe(320);
    expect(el.h).toBe(240);
  });

  it("selectedId を保持する", () => {
    const s = { ...makeState([imageEl(1, { x: 0, y: 300 })]), selectedId: "img-1" };
    expect(clampElementsToPage(s).selectedId).toBe("img-1");
  });

  it("冪等: 一度引き戻したら再適用は no-op", () => {
    const once = clampElementsToPage(makeState([imageEl(1, { x: 400, y: 300, w: 90, h: 60 })]));
    expect(clampElementsToPage(once)).toBe(once);
  });

  it("用紙内の要素は動かさず、外の要素だけ戻す", () => {
    const s = makeState([
      imageEl(1, { x: 20, y: 20, w: 60, h: 40 }), // 用紙内
      imageEl(2, { x: 0, y: 260, w: 60, h: 40 }), // 用紙外(下)
    ]);
    const out = clampElementsToPage(s);
    const a = byId(out, "img-1");
    const b = byId(out, "img-2");
    expect(a.y).toBe(20); // 不動
    expect(b.y).toBeCloseTo(170, 6); // 210 − 40
  });
});
