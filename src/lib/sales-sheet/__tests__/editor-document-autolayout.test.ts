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
  A4_PORTRAIT,
  type SalesSheetDocument,
  type SalesSheetPage,
  type ImageElement,
} from "../document-schema";
import { CONSUMER_PHOTO_ZONE } from "../layout-engine";

const SRC = "/uploads/properties/a/1.jpg";

function makeDoc(
  elements: unknown[] = [],
  page: SalesSheetPage = A4_LANDSCAPE,
): SalesSheetDocument {
  return parseSalesSheetDocument({
    page,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79", template: "consumer-2026-09" },
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

/** 写真ゾーン(消費者向けひな型): CONSUMER_PHOTO_ZONE(x7 y19.5 w124 h148)固定。 */
const ZONE = {
  x: CONSUMER_PHOTO_ZONE.x,
  y: CONSUMER_PHOTO_ZONE.y,
  right: CONSUMER_PHOTO_ZONE.x + CONSUMER_PHOTO_ZONE.w,
  bottom: CONSUMER_PHOTO_ZONE.y + CONSUMER_PHOTO_ZONE.h,
};

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

  it("入りきるなら大きさはそのまま・写真は切らずに全体を見せる(fit:contain)", () => {
    // 第②段(発注者判断 2026-09-16): 自動整列は大きさを保って位置だけ詰める。
    const s = autoArrangePhotos(
      makeState([imageEl(1, { w: 60, h: 34 }), imageEl(2, { w: 30, h: 40 }), imageEl(3, { w: 40, h: 30 })]),
    );
    const [a, b, c] = images(s);
    expect([a.w, a.h]).toEqual([60, 34]);
    expect([b.w, b.h]).toEqual([30, 40]);
    expect([c.w, c.h]).toEqual([40, 30]);
    for (const img of images(s)) expect(img.fit).toBe("contain");
    expect(s.dirty).toBe(true);
  });

  it("aspects 未指定は現枠の w/h 比を使う", () => {
    const s = autoArrangePhotos(makeState([imageEl(1, { w: 80, h: 40 })])); // 2:1
    const [img] = images(s);
    expect(img.w / img.h).toBeCloseTo(2, 3);
  });

  it("ゾーン内・重なりなし(大きさの違う5枚・入りきらなければ同じ割合で縮む)", () => {
    const s = autoArrangePhotos(
      makeState([
        imageEl(1, { w: 90, h: 60 }),
        imageEl(2, { w: 45, h: 60 }),
        imageEl(3, { w: 80, h: 60 }),
        imageEl(4, { w: 80, h: 60 }),
        imageEl(5, { w: 90, h: 60 }),
      ]),
    );
    const imgs = images(s);
    expect(imgs).toHaveLength(5);
    for (const img of imgs) expectInZone(img, ZONE);
    expectNoOverlaps(imgs);
    // 縮めるときは全部同じ割合(大きさの比を保つ)
    expect(imgs[0].w / imgs[1].w).toBeCloseTo(90 / 45, 3);
  });

  it("読み順=ドキュメント配列順(代表=先頭が読み順で先)", () => {
    // モザイク配置は行構造でないため読み順は配列順で決める(冪等性の担保)。
    // 配列先頭 img-1 は読み順で先=左上寄り(上にある、または同じ高さなら左)に来る。
    const s = autoArrangePhotos(makeState([imageEl(1), imageEl(2)]));
    const a = images(s).find((i) => i.id === "img-1")!;
    const b = images(s).find((i) => i.id === "img-2")!;
    const aFirst = a.y < b.y - 0.01 || (Math.abs(a.y - b.y) <= 0.01 && a.x <= b.x + 0.01);
    expect(aFirst).toBe(true);
  });

  it("手動で位置を入れ替えても読み順は配列順(=代表先頭)を維持する", () => {
    // img-1 を右下・img-2 を左上へ手動配置しても、配列先頭 img-1 が読み順で先。
    // 位置由来の読み順再導出だと再適用で順序が揺れる(冪等性が壊れる)ため配列順で固定。
    const s = autoArrangePhotos(
      makeState([
        imageEl(1, { x: 120, y: 120, w: 60, h: 40 }), // 手動: 右下
        imageEl(2, { x: 10, y: 50, w: 60, h: 40 }), //  手動: 左上
      ]),
    );
    const a = images(s).find((i) => i.id === "img-1")!;
    const b = images(s).find((i) => i.id === "img-2")!;
    const aFirst = a.y < b.y - 0.01 || (Math.abs(a.y - b.y) <= 0.01 && a.x <= b.x + 0.01);
    expect(aFirst).toBe(true);
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
    const once = autoArrangePhotos(makeState([imageEl(1), imageEl(2), imageEl(3)]));
    const twice = autoArrangePhotos(once);
    expect(twice).toBe(once);
  });

  it("多数(12枚)でも正のサイズ・ゾーン内・非重複", () => {
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
  });

  it("A4縦の図面では何もしない", () => {
    const s = makeState([imageEl(1), imageEl(2)], A4_PORTRAIT);
    expect(autoArrangePhotos(s)).toBe(s);
  });
});
