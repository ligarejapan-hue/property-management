/**
 * TDD: editor-document 自動レイアウト（段組み詰め版・2026-07-16 実機フィードバック対応）
 *   autoArrangePhotos: ギャラリー写真を「見た目の順」で左2/3ゾーンへ段組み詰め。
 *   overview(物件種目の枠)は定位置(右1/3)へスナップ。テンプレ枠・非画像要素は不動。
 */
import { describe, it, expect } from "vitest";
import {
  type EditorState,
  autoArrangePhotos,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type SalesSheetPage,
  type ImageElement,
} from "../document-schema";

const SRC = "/uploads/properties/a/1.jpg";

function makeDoc(
  elements: unknown[] = [],
  page: SalesSheetPage = A4_LANDSCAPE,
): SalesSheetDocument {
  return parseSalesSheetDocument({
    page,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
}
function makeState(
  elements: unknown[] = [],
  page: SalesSheetPage = A4_LANDSCAPE,
): EditorState {
  return { document: makeDoc(elements, page), selectedId: null, dirty: false };
}
/** ギャラリー追加直後を模す: ほぼ中央に積み重なった 90×60。 */
const imageEl = (n: number, over: Record<string, unknown> = {}) => ({
  id: `img-${n}`, type: "image", x: 103, y: 75, w: 90, h: 60, z: n, src: SRC, fit: "cover", ...over,
});
const textEl = () => ({
  id: "t-1", type: "text", x: 10, y: 8, w: 180, h: 10, z: 9, content: "売土地", style: {},
});
/** id="overview" の概要表(物件種目の枠)。 */
const overviewEl = (x: number) => ({
  id: "overview", type: "table", x, y: 26, w: 287 - x, h: 158, z: 1,
  rows: [{ label: "物件種別", value: "売地" }], style: {},
});

const images = (s: EditorState): ImageElement[] =>
  s.document.elements.filter(
    (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
  );

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  const eps = 0.01;
  return (
    a.x + eps < b.x + b.w && b.x + eps < a.x + a.w &&
    a.y + eps < b.y + b.h && b.y + eps < a.y + a.h
  );
}
function expectNoOverlaps(imgs: ImageElement[]): void {
  for (let i = 0; i < imgs.length; i++) {
    for (let j = i + 1; j < imgs.length; j++) {
      expect(overlaps(imgs[i], imgs[j]), `${imgs[i].id} x ${imgs[j].id}`).toBe(false);
    }
  }
}

/** 写真ゾーン(A4横): 左2/3固定。overview あり=右端177(188−11)・無し=187(198−11)。
 *  下端=mainBottom(184) − salesPoints(7) − gap(4) = 173。 */
const ZONE_WITH_OVERVIEW = { x: 10, y: 46, right: 177, bottom: 173 };
const ZONE_FREEFORM = { x: 10, y: 46, right: 187, bottom: 173 };

function expectInZone(
  img: { x: number; y: number; w: number; h: number },
  zone: { x: number; y: number; right: number; bottom: number },
): void {
  expect(img.x).toBeGreaterThanOrEqual(zone.x - 0.01);
  expect(img.y).toBeGreaterThanOrEqual(zone.y - 0.01);
  expect(img.x + img.w).toBeLessThanOrEqual(zone.right + 0.01);
  expect(img.y + img.h).toBeLessThanOrEqual(zone.bottom + 0.01);
}

describe("autoArrangePhotos(段組み詰め)", () => {
  it("画像が無ければ no-op(同一参照)・空ドキュメントも no-op", () => {
    const s1 = makeState([textEl()]);
    expect(autoArrangePhotos(s1)).toBe(s1);
    const s2 = makeState();
    expect(autoArrangePhotos(s2)).toBe(s2);
  });

  it("枠は写真の実寸縦横比になる(aspects 指定・切り取り/letterboxなし)", () => {
    const s = autoArrangePhotos(
      makeState([imageEl(1), imageEl(2), imageEl(3)]),
      { aspects: { "img-1": 16 / 9, "img-2": 3 / 4, "img-3": 4 / 3 } },
    );
    const [a, b, c] = images(s);
    expect(a.w / a.h).toBeCloseTo(16 / 9, 3);
    expect(b.w / b.h).toBeCloseTo(3 / 4, 3);
    expect(c.w / c.h).toBeCloseTo(4 / 3, 3);
    for (const img of images(s)) expect(img.fit).toBe("contain");
    expect(s.dirty).toBe(true);
  });

  it("aspects 未指定は現枠の w/h 比を使う", () => {
    const s = autoArrangePhotos(makeState([imageEl(1, { w: 80, h: 40 })])); // 2:1
    const [img] = images(s);
    expect(img.w / img.h).toBeCloseTo(2, 3);
  });

  it("ゾーン内・重なりなし(混在比5枚)・面積使用率が高い", () => {
    const s = autoArrangePhotos(
      makeState([imageEl(1), imageEl(2), imageEl(3), imageEl(4), imageEl(5)]),
      { aspects: { "img-1": 1.78, "img-2": 0.75, "img-3": 1.33, "img-4": 1.33, "img-5": 1.5 } },
    );
    const imgs = images(s);
    expect(imgs).toHaveLength(5);
    for (const img of imgs) expectInZone(img, ZONE_FREEFORM);
    expectNoOverlaps(imgs);
    const zoneArea = (ZONE_FREEFORM.right - 10) * (ZONE_FREEFORM.bottom - 46);
    const used = imgs.reduce((s2, r) => s2 + r.w * r.h, 0);
    expect(used / zoneArea).toBeGreaterThan(0.5);
  });

  it("overview があるときは写真ゾーン右端=177(常に左2/3固定)", () => {
    const s = autoArrangePhotos(
      makeState([overviewEl(188), imageEl(1), imageEl(2), imageEl(3), imageEl(4)]),
    );
    for (const img of images(s)) expectInZone(img, ZONE_WITH_OVERVIEW);
  });

  it("overview が定位置より左(古い図面)なら x=188/右端287 へスナップし、写真は177まで", () => {
    const s = autoArrangePhotos(makeState([overviewEl(120), imageEl(1), imageEl(2)]));
    const ov = s.document.elements.find((e) => e.id === "overview")!;
    expect(ov.x).toBe(188);
    expect(ov.x + ov.w).toBe(287);
    expect(ov.y).toBe(26); // y/h は維持
    for (const img of images(s)) {
      expect(img.x + img.w).toBeLessThanOrEqual(177 + 0.01);
    }
  });

  it("A4縦でも overview スナップは用紙内(ページ幅から相対計算・@codex R5)", () => {
    const portrait = { width: 210, height: 297, orientation: "portrait" } as const;
    const ov = { id: "overview", type: "table", x: 120, y: 26, w: 80, h: 150, z: 1,
      rows: [{ label: "物件種別", value: "売地" }], style: {} };
    const s = autoArrangePhotos(makeState([ov, imageEl(1)], portrait));
    const after = s.document.elements.find((e) => e.id === "overview")!;
    // 定位置 = 右端(210-10=200)から幅の1/3(70): x=130・右端200 ≤ 210。
    expect(after.x).toBeCloseTo(130, 3);
    expect(after.x + after.w).toBeLessThanOrEqual(210);
    for (const img of images(s)) {
      expect(img.x + img.w).toBeLessThanOrEqual(210);
    }
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("並び順=見た目の順(上の行から左→右)を保つ", () => {
    // img-1 を下段・img-2 を上段に置いた状態から整列 → img-2 が先(上)になる。
    const s = autoArrangePhotos(
      makeState([
        imageEl(1, { x: 10, y: 120, w: 60, h: 40 }),
        imageEl(2, { x: 10, y: 50, w: 60, h: 40 }),
      ]),
    );
    const a = images(s).find((i) => i.id === "img-1")!;
    const b = images(s).find((i) => i.id === "img-2")!;
    expect(b.y).toBeLessThan(a.y); // 上にあった img-2 が上のまま
  });

  it("同じ行で高さが違う写真(手動リサイズ後)でも左→右の順を保つ(@codex R4)", () => {
    // 上端は同じ・高さ違い: 左=背が高い(60)・右=低い(20)。y中心なら右が先になる崩れ方をする。
    const s = autoArrangePhotos(
      makeState([
        imageEl(1, { x: 80, y: 50, w: 60, h: 20 }), // 右・低い
        imageEl(2, { x: 10, y: 50, w: 60, h: 60 }), // 左・高い
      ]),
    );
    const right = images(s).find((i) => i.id === "img-1")!;
    const left = images(s).find((i) => i.id === "img-2")!;
    // 同一行なら left.x < right.x、行が分かれるなら left が上=いずれも左が先。
    const leftFirst = left.y < right.y - 0.01 || (Math.abs(left.y - right.y) <= 0.01 && left.x < right.x);
    expect(leftFirst).toBe(true);
  });

  it("appendedId は末尾(読み順で最後)に入る", () => {
    // 2枚整列済み → 3枚目をゾーン左上寄りへ仮置き → appendedId 指定で整列。
    const two = autoArrangePhotos(makeState([imageEl(1), imageEl(2)]));
    const added: EditorState = {
      ...two,
      dirty: false,
      document: {
        ...two.document,
        elements: [
          ...two.document.elements,
          { id: "img-3", type: "image", x: 100, y: 40, w: 90, h: 60, z: 3, src: SRC, fit: "cover" },
        ],
      },
    };
    const s = autoArrangePhotos(added, { appendedId: "img-3" });
    const imgs = images(s);
    const c = imgs.find((i) => i.id === "img-3")!;
    for (const img of imgs) {
      if (img.id === "img-3") continue;
      const cAfter = c.y > img.y + 0.01 || (Math.abs(c.y - img.y) <= 0.01 && c.x > img.x);
      expect(cAfter, `img-3 should come after ${img.id}`).toBe(true);
    }
  });

  it("間取り図(floor-plan)は不動・写真はその下から敷く", () => {
    const floorPlan = {
      id: "floor-plan", type: "image", x: 10, y: 46, w: 32, h: 18, z: 1, src: SRC, fit: "contain",
    };
    const before = makeState([floorPlan, imageEl(1), imageEl(2)]);
    const after = autoArrangePhotos(before);
    expect(after.document.elements[0]).toBe(before.document.elements[0]);
    const fp = after.document.elements[0];
    for (const img of images(after)) {
      expect(overlaps(img, fp)).toBe(false);
      expect(img.y).toBeGreaterThanOrEqual(fp.y + fp.h - 0.01);
    }
  });

  it("間取り図が巨大で写真ゾーンが潰れている場合は no-op(負寸法を書き込まない)", () => {
    // floor-plan を縦に大きくリサイズ → 写真ゾーン高さが最小要素サイズ未満 → 整列しない。
    const hugeFloorPlan = {
      id: "floor-plan", type: "image", x: 10, y: 46, w: 60, h: 125, z: 1, src: SRC, fit: "contain",
    };
    const s2 = makeState([hugeFloorPlan, imageEl(1), imageEl(2)]);
    expect(autoArrangePhotos(s2)).toBe(s2);
  });

  it("非画像要素(テキスト)は参照ごと不動・幾何/fit以外(id/src/焦点/alt/z)は保存", () => {
    const before = makeState([
      textEl(),
      imageEl(1, { focalX: 20, focalY: 80, radiusMm: 2, alt: "外観", z: 7 }),
    ]);
    const after = autoArrangePhotos(before);
    expect(after.document.elements[0]).toBe(before.document.elements[0]);
    const img = after.document.elements[1] as ImageElement;
    expect(img.id).toBe("img-1");
    expect(img.src).toBe(SRC);
    expect(img.focalX).toBe(20);
    expect(img.focalY).toBe(80);
    expect(img.radiusMm).toBe(2);
    expect(img.alt).toBe("外観");
    expect(img.z).toBe(7);
  });

  it("結果は schema 検証を通る(保存可能)・selectedId 不変", () => {
    const before = { ...makeState([imageEl(1), imageEl(2)]), selectedId: "img-1" };
    const s = autoArrangePhotos(before);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
    expect(s.selectedId).toBe("img-1");
  });

  it("決定的・冪等: 整列済みへの再適用は no-op(同一参照)", () => {
    const aspects = { "img-1": 1.78, "img-2": 1.33, "img-3": 0.75 };
    const once = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]), { aspects });
    const twice = autoArrangePhotos(once, { aspects });
    expect(twice).toBe(once);
  });

  it("多数(12枚)でも正のサイズ・ゾーン内・非重複", () => {
    const els = Array.from({ length: 12 }, (_, i) => imageEl(i + 1));
    const s = autoArrangePhotos(makeState(els));
    const imgs = images(s);
    expect(imgs).toHaveLength(12);
    for (const img of imgs) {
      expectInZone(img, ZONE_FREEFORM);
      expect(img.w).toBeGreaterThan(0);
      expect(img.h).toBeGreaterThan(0);
    }
    expectNoOverlaps(imgs);
  });
});
