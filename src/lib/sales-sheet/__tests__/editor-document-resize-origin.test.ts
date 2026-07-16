import { describe, it, expect } from "vitest";
import { resizeElementWithOrigin, type EditorState } from "../editor-document";
import { parseSalesSheetDocument, A4_LANDSCAPE } from "../document-schema";

const el = (x: number, y: number, w: number, h: number) => ({
  id: "t", type: "text", x, y, w, h, z: 1, content: "x", style: {},
});
const state = (e: unknown): EditorState => ({
  document: parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements: [e],
  }),
  selectedId: null,
  dirty: false,
});

describe("resizeElementWithOrigin(サイズ+原点の一括クランプ)", () => {
  it("右端の要素を左ハンドルで縮めても位置が歪まない(旧wでのxクランプ回避)", () => {
    // 右端接地(x=257,w=40 → 右端297)。左から縮小: x=277,w=20 を期待どおり適用。
    const s = resizeElementWithOrigin(state(el(257, 10, 40, 20)), "t", { x: 277, y: 10, w: 20, h: 20 });
    const e = s.document.elements[0];
    expect(e.x).toBe(277);
    expect(e.w).toBe(20);
  });

  it("右端の要素を左ハンドルで広げても右端は保たれ w が旧xで削られない", () => {
    // x=257,w=40(右端297) → 左へ拡大 x=237,w=60。
    const s = resizeElementWithOrigin(state(el(257, 10, 40, 20)), "t", { x: 237, y: 10, w: 60, h: 20 });
    const e = s.document.elements[0];
    expect(e.x).toBe(237);
    expect(e.w).toBe(60);
    expect(e.x + e.w).toBeLessThanOrEqual(297);
  });

  it("ページ外へは出ない(x+w≤width・y+h≤height・最小5mm)", () => {
    const s = resizeElementWithOrigin(state(el(10, 10, 40, 20)), "t", { x: -5, y: -5, w: 999, h: 999 });
    const e = s.document.elements[0];
    expect(e.x).toBeGreaterThanOrEqual(0);
    expect(e.y).toBeGreaterThanOrEqual(0);
    expect(e.x + e.w).toBeLessThanOrEqual(297);
    expect(e.y + e.h).toBeLessThanOrEqual(210);
    const s2 = resizeElementWithOrigin(state(el(10, 10, 40, 20)), "t", { x: 10, y: 10, w: 1, h: 1 });
    expect(s2.document.elements[0].w).toBe(5);
    expect(s2.document.elements[0].h).toBe(5);
  });

  it("未知idは no-op(同一参照)", () => {
    const s0 = state(el(10, 10, 40, 20));
    expect(resizeElementWithOrigin(s0, "nope", { x: 1, y: 1, w: 10, h: 10 })).toBe(s0);
  });
});
