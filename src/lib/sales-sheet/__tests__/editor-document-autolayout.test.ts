/**
 * TDD: editor-document 自動レイアウト（計画⑥）
 *   autoArrangePhotos: image 要素だけを写真ゾーンへ決定的に整列し直す。
 *   非画像要素は不動。「良い既定＋手動上書き」（プロト v4 の結論）。
 */
import { describe, it, expect } from "vitest";
import {
  type EditorState,
  autoArrangePhotos,
  MIN_ELEMENT_SIZE_MM,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  A4_PORTRAIT,
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
const tableEl = () => ({
  id: "tbl-1", type: "table", x: 150, y: 22, w: 137, h: 160, z: 1,
  rows: [{ label: "所在地", value: "x" }], style: {},
});

const images = (s: EditorState): ImageElement[] =>
  s.document.elements.filter((e): e is ImageElement => e.type === "image");

/** 矩形の重なり判定（辺の接触は重なりとしない・誤差 1/1000mm 許容）。 */
function overlaps(a: ImageElement, b: ImageElement): boolean {
  const eps = 0.001;
  return (
    a.x + eps < b.x + b.w - eps && b.x + eps < a.x + a.w - eps &&
    a.y + eps < b.y + b.h - eps && b.y + eps < a.y + a.h - eps
  );
}

function expectInZone(
  img: ImageElement,
  zone: { x: number; y: number; right: number; bottom: number },
): void {
  expect(img.x).toBeGreaterThanOrEqual(zone.x - 0.001);
  expect(img.y).toBeGreaterThanOrEqual(zone.y - 0.001);
  expect(img.x + img.w).toBeLessThanOrEqual(zone.right + 0.001);
  expect(img.y + img.h).toBeLessThanOrEqual(zone.bottom + 0.001);
}

function expectNoOverlaps(imgs: ImageElement[]): void {
  for (let i = 0; i < imgs.length; i++) {
    for (let j = i + 1; j < imgs.length; j++) {
      expect(overlaps(imgs[i], imgs[j])).toBe(false);
    }
  }
}

/** 写真ゾーン(A4横): テンプレの左カラム x10-140 / y46-186（概要表・会社帯を避ける既定）。 */
const ZONE = { x: 10, y: 46, right: 140, bottom: 186 };

describe("autoArrangePhotos", () => {
  it("画像が無ければ no-op（同一参照）", () => {
    const s = makeState([textEl(), tableEl()]);
    expect(autoArrangePhotos(s)).toBe(s);
  });

  it("空ドキュメントも no-op（同一参照）", () => {
    const s = makeState();
    expect(autoArrangePhotos(s)).toBe(s);
  });

  it("写真1枚は写真ゾーン全面に配置し dirty 化", () => {
    const s = autoArrangePhotos(makeState([imageEl(1)]));
    const [img] = images(s);
    expect(img.x).toBeCloseTo(ZONE.x, 3);
    expect(img.y).toBeCloseTo(ZONE.y, 3);
    expect(img.w).toBeCloseTo(ZONE.right - ZONE.x, 3);
    expect(img.h).toBeCloseTo(ZONE.bottom - ZONE.y, 3);
    expect(s.dirty).toBe(true);
  });

  it("中央に積み重なった写真3枚を、ゾーン内に重なりなく並べる", () => {
    const s = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]));
    const imgs = images(s);
    expect(imgs).toHaveLength(3);
    for (const img of imgs) {
      expectInZone(img, ZONE);
      expect(img.w).toBeGreaterThanOrEqual(MIN_ELEMENT_SIZE_MM);
      expect(img.h).toBeGreaterThanOrEqual(MIN_ELEMENT_SIZE_MM);
    }
    expectNoOverlaps(imgs);
  });

  it("写真5枚もゾーン内・重なりなし・十分な大きさ", () => {
    const s = autoArrangePhotos(
      makeState([imageEl(1), imageEl(2), imageEl(3), imageEl(4), imageEl(5)]),
    );
    const imgs = images(s);
    expect(imgs).toHaveLength(5);
    for (const img of imgs) {
      expectInZone(img, ZONE);
      expect(img.w).toBeGreaterThanOrEqual(MIN_ELEMENT_SIZE_MM);
      expect(img.h).toBeGreaterThanOrEqual(MIN_ELEMENT_SIZE_MM);
    }
    expectNoOverlaps(imgs);
  });

  it("非画像要素（テキスト/表）は参照ごと不動", () => {
    const before = makeState([textEl(), imageEl(1), tableEl(), imageEl(2)]);
    const after = autoArrangePhotos(before);
    expect(after.document.elements[0]).toBe(before.document.elements[0]);
    expect(after.document.elements[2]).toBe(before.document.elements[2]);
  });

  it("幾何以外（id/src/fit/焦点/角丸/alt/z）と配列内の位置は保存する", () => {
    const before = makeState([
      imageEl(1, { fit: "contain", focalX: 20, focalY: 80, radiusMm: 2, alt: "外観", z: 7 }),
      textEl(),
      imageEl(2),
    ]);
    const after = autoArrangePhotos(before);
    const el0 = after.document.elements[0] as ImageElement;
    expect(el0.id).toBe("img-1");
    expect(el0.src).toBe(SRC);
    expect(el0.fit).toBe("contain");
    expect(el0.focalX).toBe(20);
    expect(el0.focalY).toBe(80);
    expect(el0.radiusMm).toBe(2);
    expect(el0.alt).toBe("外観");
    expect(el0.z).toBe(7);
    expect(after.document.elements[1].type).toBe("text");
    expect(after.document.elements[2].id).toBe("img-2");
  });

  it("先頭の画像（代表写真）が最上段・左端に来る", () => {
    const s = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]));
    const imgs = images(s);
    const first = imgs[0];
    for (const img of imgs) {
      expect(first.y).toBeLessThanOrEqual(img.y + 0.001);
      if (Math.abs(img.y - first.y) < 0.001) {
        expect(first.x).toBeLessThanOrEqual(img.x + 0.001);
      }
    }
  });

  it("写真3枚は上段に代表写真1枚（幅広）＋下段2枚（テンプレの3枚構造と同じ）", () => {
    const s = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]));
    const [first, second, third] = images(s);
    // 代表写真（先頭）: 上段をひとりで使う＝ゾーン全幅
    expect(first.x).toBeCloseTo(ZONE.x, 3);
    expect(first.y).toBeCloseTo(ZONE.y, 3);
    expect(first.w).toBeCloseTo(ZONE.right - ZONE.x, 3);
    // 残り2枚は下段に横並び・同サイズ
    expect(second.y).toBeCloseTo(third.y, 3);
    expect(second.y).toBeGreaterThan(first.y + first.h);
    expect(second.w).toBeCloseTo(third.w, 3);
    expect(second.x).toBeLessThan(third.x);
  });

  it("写真4枚は 2×2 の均等グリッド（横長の帯にしない）", () => {
    const s = autoArrangePhotos(
      makeState([imageEl(1), imageEl(2), imageEl(3), imageEl(4)]),
    );
    const imgs = images(s);
    // 全セル同サイズ
    for (const img of imgs) {
      expect(img.w).toBeCloseTo(imgs[0].w, 3);
      expect(img.h).toBeCloseTo(imgs[0].h, 3);
    }
    // 2行×2列: x は2種・y は2種
    const xs = [...new Set(imgs.map((i) => Math.round(i.x * 100) / 100))];
    const ys = [...new Set(imgs.map((i) => Math.round(i.y * 100) / 100))];
    expect(xs).toHaveLength(2);
    expect(ys).toHaveLength(2);
  });

  it("結果 document は schema 検証を通る（保存可能）", () => {
    const s = autoArrangePhotos(
      makeState([textEl(), imageEl(1), imageEl(2), imageEl(3), imageEl(4)]),
    );
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("決定的: 同一入力から常に同一の幾何", () => {
    const a = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]));
    const b = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]));
    expect(images(a).map(({ x, y, w, h }) => ({ x, y, w, h })))
      .toEqual(images(b).map(({ x, y, w, h }) => ({ x, y, w, h })));
  });

  it("冪等: 整列済みへの再適用は no-op（同一参照）", () => {
    const once = autoArrangePhotos(makeState([imageEl(1), imageEl(2)]));
    expect(autoArrangePhotos(once)).toBe(once);
  });

  it("selectedId は変更しない", () => {
    const before = { ...makeState([imageEl(1)]), selectedId: "img-1" };
    const after = autoArrangePhotos(before);
    expect(after.selectedId).toBe("img-1");
  });

  it("A4縦でもページ内（下部の会社帯領域は避ける）に収まる", () => {
    const s = autoArrangePhotos(
      makeState([imageEl(1), imageEl(2), imageEl(3)], A4_PORTRAIT),
    );
    const imgs = images(s);
    expect(imgs).toHaveLength(3);
    for (const img of imgs) {
      expectInZone(img, { x: 10, y: 46, right: 210 - 10, bottom: 297 - 24 });
    }
    expectNoOverlaps(imgs);
  });

  it("多数（12枚）でも正のサイズでゾーン内に非重複配置", () => {
    const els = Array.from({ length: 12 }, (_, i) => imageEl(i + 1));
    const s = autoArrangePhotos(makeState(els));
    const imgs = images(s);
    expect(imgs).toHaveLength(12);
    for (const img of imgs) {
      expectInZone(img, ZONE);
      expect(img.w).toBeGreaterThan(0);
      expect(img.h).toBeGreaterThan(0);
    }
    expectNoOverlaps(imgs);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });
});
