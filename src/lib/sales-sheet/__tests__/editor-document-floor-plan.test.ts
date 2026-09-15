import { describe, it, expect } from "vitest";
import { type EditorState, setAsFloorPlan, unsetFloorPlan, autoArrangePhotos } from "../editor-document";
import { parseSalesSheetDocument, salesSheetDocumentSchema, A4_LANDSCAPE } from "../document-schema";
import { CONSUMER_PHOTO_ZONE } from "../layout-engine";

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
const ids = (s: EditorState) => s.document.elements.filter((e) => e.type === "image").map((e) => e.id);

describe("setAsFloorPlan / unsetFloorPlan(間取り図は写真の仲間)", () => {
  it("選んだ写真が floor-plan になり、写真枠に並び直る", () => {
    const s = makeState([img(1), img(2)]);
    const next = setAsFloorPlan({ ...s, selectedId: "img-2" }, "img-2", "demoted", { "img-1": 1.5, "img-2": 1 });
    expect(ids(next)).toEqual(["img-1", "floor-plan"]);
    expect(next.selectedId).toBe("floor-plan");
    expect(next.dirty).toBe(true);
    for (const e of next.document.elements) expect(insideZone(e)).toBe(true);
    const fp = next.document.elements.find((e) => e.id === "floor-plan");
    expect(fp?.type === "image" && fp.fit).toBe("contain");
    // 実寸比は新しい id に引き継がれる(1:1 のまま並ぶ)
    expect(fp && fp.w / fp.h).toBeCloseTo(1, 3);
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("既存の間取り図は demotedId の写真に戻る(常に1枚)", () => {
    const s = makeState([{ ...img(1), id: "floor-plan" }, img(2)]);
    const next = setAsFloorPlan(s, "img-2", "demoted", { "floor-plan": 0.7, "img-2": 1.5 });
    expect(ids(next).sort()).toEqual(["demoted", "floor-plan"]);
    const demoted = next.document.elements.find((e) => e.id === "demoted");
    expect(demoted && demoted.w / demoted.h).toBeCloseTo(0.7, 3);
  });
  it("写真でない id・floor-plan 自身は何もしない", () => {
    const s = makeState([{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, z: 1, content: "x" }, { ...img(1), id: "floor-plan" }]);
    expect(setAsFloorPlan(s, "t", "d")).toBe(s);
    expect(setAsFloorPlan(s, "floor-plan", "d")).toBe(s);
    expect(setAsFloorPlan(s, "none", "d")).toBe(s);
  });
  it("unsetFloorPlan は newId の写真に戻し、実寸比を引き継ぐ", () => {
    const s = makeState([{ ...img(1), id: "floor-plan" }]);
    const next = unsetFloorPlan(s, "back", { "floor-plan": 0.8 });
    expect(ids(next)).toEqual(["back"]);
    expect(next.selectedId).toBe("back");
    const back = next.document.elements[0];
    expect(back.w / back.h).toBeCloseTo(0.8, 3);
    expect(unsetFloorPlan(makeState([img(1)]), "x")).toEqual(makeState([img(1)]));
  });
  it("整列済みへの再整列は同一参照", () => {
    const s = setAsFloorPlan(makeState([img(1), img(2)]), "img-2", "d", { "img-1": 1.5, "img-2": 1 });
    expect(autoArrangePhotos(s, { aspects: { "img-1": 1.5, "floor-plan": 1 } })).toBe(s);
  });
});
