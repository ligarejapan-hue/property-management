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
  commitFloorPlanGeometry,
  autoArrangePhotos,
  deleteElement,
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

  it("写真1枚を間取り図にしても概要表が定位置(右1/3)へスナップし重ならない(@codex #298)", () => {
    // overview を左寄り(x=120)に手動配置＋写真1枚。その1枚を間取り図に→写真0枚でも概要表を寄せる。
    const movedOverview = {
      id: "overview", type: "table", x: 120, y: 26, w: 100, h: 158, z: 1,
      rows: [{ label: "物件種別", value: "売地" }], style: {},
    };
    const s = setAsFloorPlan(makeState([img(1), movedOverview]), "img-1", "d");
    const ov = byId(s, "overview") as ImageElement; // table だが x/w だけ見る
    const fp = byId(s, "floor-plan") as ImageElement;
    expect(ov.x).toBeCloseTo(188, 0); // 定位置(右1/3=297−10−99)へスナップ
    expect(fp.x + fp.w).toBeLessThanOrEqual(ov.x + 0.5); // 図が概要表に食い込まない
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

describe("commitFloorPlanGeometry（中央列の幾何確定＋写真リフローを1更新で）", () => {
  const withFp = () =>
    setAsFloorPlan(makeState([img(1), img(2), img(3), overviewEl()]), "img-1", "d");
  const photosRightMost = (s: EditorState) =>
    Math.max(
      ...s.document.elements
        .filter((e): e is ImageElement => e.type === "image" && e.id !== "floor-plan")
        .map((e) => e.x + e.w),
    );

  it("resize: どの幅でも図の右端は概要表の左(182)へアンカーされる(@codex #298)", () => {
    for (const w of [40, 60, 90]) {
      const s = commitFloorPlanGeometry(withFp(), { mode: "resize", w, h: 100 });
      const fp = byId(s, "floor-plan") as ImageElement;
      expect(fp.x + fp.w).toBeCloseTo(182, 1); // 右端固定=右ハンドルでも概要表へ食い込まない
    }
  });

  it("resize で図を広げると左端が動き、写真が反比例で左へ狭まる", () => {
    const base = withFp();
    const narrow = commitFloorPlanGeometry(base, { mode: "resize", w: 40, h: 100 }); // 図が狭い
    const wide = commitFloorPlanGeometry(base, { mode: "resize", w: 90, h: 100 }); // 図が広い
    expect(photosRightMost(wide)).toBeLessThan(photosRightMost(narrow));
  });

  it("move: 図の右端は概要表を越えない(食い込み防止)", () => {
    const s = commitFloorPlanGeometry(withFp(), { mode: "move", x: 250, y: 46 });
    const fp = byId(s, "floor-plan") as ImageElement;
    expect(fp.x + fp.w).toBeLessThanOrEqual(182 + 0.5);
  });

  it("move: 図を左端いっぱいへ動かしても写真ゾーンが潰れず写真と重ならない(@codex #298 P1)", () => {
    const s = commitFloorPlanGeometry(withFp(), { mode: "move", x: 0, y: 46 }); // 左端へ
    const fp = byId(s, "floor-plan") as ImageElement;
    // 左端は minX(=10+5+6=21)より左へ行かない=写真ゾーンが最小サイズ分残る。
    expect(fp.x).toBeGreaterThanOrEqual(21 - 0.5);
    const photos = s.document.elements.filter(
      (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
    );
    for (const p of photos) expect(p.x + p.w).toBeLessThanOrEqual(fp.x + 0.5); // 重ならない
  });

  it("間取り図を削除→自動整列で写真が左2/3へ広がる(2列復帰・@codex #298)", () => {
    const withFp = setAsFloorPlan(makeState([img(1), img(2), img(3), overviewEl()]), "img-1", "d");
    const rightWithFp = photosRightMost(withFp); // 図がある=写真は左列(狭い)
    const deleted = autoArrangePhotos(deleteElement(withFp, "floor-plan"));
    const photos = deleted.document.elements.filter(
      (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
    );
    expect(deleted.document.elements.some((e) => e.id === "floor-plan")).toBe(false);
    expect(Math.max(...photos.map((p) => p.x + p.w))).toBeGreaterThan(rightWithFp); // 右へ広がる
  });

  it("結果は schema 検証を通る・floor-plan が無ければ no-op", () => {
    const s = commitFloorPlanGeometry(withFp(), { mode: "resize", w: 60, h: 110 });
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
    const none = makeState([img(1), overviewEl()]);
    expect(commitFloorPlanGeometry(none, { mode: "resize", w: 50, h: 100 })).toBe(none);
  });
});
