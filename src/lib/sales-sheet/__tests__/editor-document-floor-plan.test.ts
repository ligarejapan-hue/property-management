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
    const next = setAsFloorPlan({ ...s, selectedId: "img-2" }, "img-2", "demoted");
    expect(ids(next)).toEqual(["img-1", "floor-plan"]);
    expect(next.selectedId).toBe("floor-plan");
    expect(next.dirty).toBe(true);
    for (const e of next.document.elements) expect(insideZone(e)).toBe(true);
    const fp = next.document.elements.find((e) => e.id === "floor-plan");
    expect(fp?.type === "image" && fp.fit).toBe("contain");
    expect(salesSheetDocumentSchema.safeParse(next.document).success).toBe(true);
  });
  it("既存の間取り図は demotedId の写真に戻る(常に1枚)", () => {
    const s = makeState([{ ...img(1), id: "floor-plan" }, img(2)]);
    const next = setAsFloorPlan(s, "img-2", "demoted");
    expect(ids(next).sort()).toEqual(["demoted", "floor-plan"]);
  });
  it("写真でない id・floor-plan 自身は何もしない", () => {
    const s = makeState([{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, z: 1, content: "x" }, { ...img(1), id: "floor-plan" }]);
    expect(setAsFloorPlan(s, "t", "d")).toBe(s);
    expect(setAsFloorPlan(s, "floor-plan", "d")).toBe(s);
    expect(setAsFloorPlan(s, "none", "d")).toBe(s);
  });
  it("unsetFloorPlan は newId の写真に戻す", () => {
    const s = makeState([{ ...img(1), id: "floor-plan" }]);
    const next = unsetFloorPlan(s, "back");
    expect(ids(next)).toEqual(["back"]);
    expect(next.selectedId).toBe("back");
    // F6: 間取り図が無ければ入力と同一参照を返す(no-op 規約。toEqual ではなく toBe)
    const noFloorPlan = makeState([img(1)]);
    expect(unsetFloorPlan(noFloorPlan, "x")).toBe(noFloorPlan);
  });
  it("間取り図にしても/写真に戻しても、大きさは保つ(第②段: 並べ直しは位置だけ)", () => {
    const s = makeState([img(1, { w: 70, h: 50 }), img(2, { w: 40, h: 30 })]);
    const next = setAsFloorPlan(s, "img-2", "demoted");
    const fp = next.document.elements.find((e) => e.id === "floor-plan")!;
    expect([fp.w, fp.h]).toEqual([40, 30]);
    const back = unsetFloorPlan(next, "back").document.elements.find((e) => e.id === "back")!;
    expect([back.w, back.h]).toEqual([40, 30]);
  });
  it("主役の写真を間取り図にしても主役の印は残る", () => {
    const s = makeState([img(1, { hero: true }), img(2)]);
    const next = setAsFloorPlan(s, "img-1", "demoted");
    const fp = next.document.elements.find((e) => e.id === "floor-plan");
    expect(fp?.type === "image" && fp.hero).toBe(true);
  });
  it("整列済みへの再整列は同一参照", () => {
    const s = setAsFloorPlan(makeState([img(1), img(2)]), "img-2", "d");
    expect(autoArrangePhotos(s)).toBe(s);
  });
});
