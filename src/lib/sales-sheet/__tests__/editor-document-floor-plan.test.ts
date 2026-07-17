/**
 * TDD: 写真↔間取り図(中央列)の指定/解除。
 *   setAsFloorPlan: 選択写真を中央列の間取り図(id="floor-plan")に。既存図は写真へ降格(常に1枚)。
 *   unsetFloorPlan: 間取り図を通常の写真へ戻す。どちらも写真を図の左へ再整列。
 */
import { describe, it, expect } from "vitest";
import {
  type EditorState,
  setAsFloorPlan,
  unsetFloorPlan,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type ImageElement,
} from "../document-schema";

const SRC = "/uploads/properties/a/1.jpg";
function makeState(elements: unknown[]): EditorState {
  const document: SalesSheetDocument = parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
  return { document, selectedId: null, dirty: false };
}
const img = (n: number, over: Record<string, unknown> = {}) => ({
  id: `img-${n}`, type: "image", x: 103, y: 75, w: 90, h: 60, z: n, src: SRC, fit: "cover", ...over,
});
const overviewEl = () => ({
  id: "overview", type: "table", x: 188, y: 26, w: 99, h: 158, z: 1,
  rows: [{ label: "物件種別", value: "売地" }], style: {},
});
const byId = (s: EditorState, id: string) => s.document.elements.find((e) => e.id === id);
const imagesLeftOf = (s: EditorState, x: number) =>
  s.document.elements.filter(
    (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
  ).every((e) => e.x + e.w <= x + 0.01);

describe("setAsFloorPlan", () => {
  it("選択写真が中央列の間取り図(id=floor-plan)になる", () => {
    const s = setAsFloorPlan(makeState([img(1), img(2), overviewEl()]), "img-1", "demoted-x");
    const fp = byId(s, "floor-plan") as ImageElement;
    expect(fp).toBeTruthy();
    expect(fp.type).toBe("image");
    expect(fp.fit).toBe("contain");
    expect(byId(s, "img-1")).toBeUndefined(); // img-1 は floor-plan に改名された
    // 中央列: 概要表(x=188)の左・写真ゾーンの右。
    expect(fp.x + fp.w).toBeLessThanOrEqual(188 + 0.01);
    expect(fp.x).toBeGreaterThan(50);
    expect(s.selectedId).toBe("floor-plan");
    expect(s.dirty).toBe(true);
  });

  it("写真は間取り図の左へ詰め直される", () => {
    const s = setAsFloorPlan(makeState([img(1), img(2), img(3), overviewEl()]), "img-1", "demoted-x");
    const fp = byId(s, "floor-plan") as ImageElement;
    expect(imagesLeftOf(s, fp.x)).toBe(true);
  });

  it("既存の間取り図がある状態で別写真を指定すると、旧図は写真へ降格(常に1枚)", () => {
    const s1 = setAsFloorPlan(makeState([img(1), img(2), overviewEl()]), "img-1", "d1");
    const s2 = setAsFloorPlan(s1, "img-2", "old-fp");
    const fps = s2.document.elements.filter((e) => e.id === "floor-plan");
    expect(fps).toHaveLength(1); // 間取り図は常に1枚
    expect((fps[0] as ImageElement).src).toBe(SRC);
    expect(byId(s2, "old-fp")).toBeTruthy(); // 旧図は降格して写真として存在
  });

  it("image でない要素・存在しない id は no-op(同一参照)", () => {
    const s = makeState([overviewEl(), img(1)]);
    expect(setAsFloorPlan(s, "overview", "d")).toBe(s);
    expect(setAsFloorPlan(s, "nope", "d")).toBe(s);
  });

  it("結果は schema 検証を通る(保存可能)", () => {
    const s = setAsFloorPlan(makeState([img(1), img(2), overviewEl()]), "img-1", "d");
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });
});

describe("unsetFloorPlan", () => {
  it("間取り図を通常の写真へ戻す", () => {
    const s1 = setAsFloorPlan(makeState([img(1), img(2), overviewEl()]), "img-1", "d1");
    const s2 = unsetFloorPlan(s1, "back-to-photo");
    expect(byId(s2, "floor-plan")).toBeUndefined();
    const back = byId(s2, "back-to-photo") as ImageElement;
    expect(back).toBeTruthy();
    expect(back.type).toBe("image");
    expect(s2.selectedId).toBe("back-to-photo");
    expect(s2.dirty).toBe(true);
  });

  it("間取り図が無ければ no-op(同一参照)", () => {
    const s = makeState([img(1), overviewEl()]);
    expect(unsetFloorPlan(s, "x")).toBe(s);
  });
});
