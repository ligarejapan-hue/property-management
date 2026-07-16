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

/** 写真ゾーン(A4横・overview 要素なしの素の版面): 左カラム x10-192 / y46-173。
 *  右端＝ページ幅297の2/3(=198)− 概要表との余白(6) = 192（要件①⑤・写真は左2/3）。
 *  下端＝エンジンの photoPackBottom = mainBottom(184) − salesPoints(7) − gap(4) = 173。 */
const ZONE = { x: 10, y: 46, right: 192, bottom: 173 };
/** id="overview" の概要表要素（物件種別の枠）。写真はこの左端を越えない。 */
const overviewEl = (x: number) => ({
  id: "overview", type: "table", x, y: 26, w: 287 - x, h: 158, z: 1,
  rows: [{ label: "物件種別", value: "売地" }], style: {},
});

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

  it("幾何と fit 以外（id/src/焦点/角丸/alt/z）と配列内の位置は保存する", () => {
    const before = makeState([
      imageEl(1, { fit: "contain", focalX: 20, focalY: 80, radiusMm: 2, alt: "外観", z: 7 }),
      textEl(),
      imageEl(2),
    ]);
    const after = autoArrangePhotos(before);
    const el0 = after.document.elements[0] as ImageElement;
    expect(el0.id).toBe("img-1");
    expect(el0.src).toBe(SRC);
    expect(el0.focalX).toBe(20);
    expect(el0.focalY).toBe(80);
    expect(el0.radiusMm).toBe(2);
    expect(el0.alt).toBe("外観");
    expect(el0.z).toBe(7);
    expect(after.document.elements[1].type).toBe("text");
    expect(after.document.elements[2].id).toBe("img-2");
  });

  it("縦横比を変えない: 各写真は fit:\"contain\"（cover 入力も contain に正規化・要件②）", () => {
    const s = autoArrangePhotos(makeState([imageEl(1), imageEl(2, { fit: "cover" }), imageEl(3)]));
    for (const img of images(s)) {
      expect(img.fit).toBe("contain");
    }
  });

  it("cover のみを contain 化する場合も変更検知して dirty 化（幾何が既に整列済みでも）", () => {
    // 1枚を先に整列（contain 化）→ もう一度 cover に戻して再整列すると fit 差だけで dirty。
    const arranged = autoArrangePhotos(makeState([imageEl(1)]));
    const coverAgain = {
      ...arranged,
      document: {
        ...arranged.document,
        elements: arranged.document.elements.map((e) =>
          e.type === "image" ? { ...e, fit: "cover" as const } : e,
        ),
      },
      dirty: false,
    };
    const re = autoArrangePhotos(coverAgain);
    expect(re).not.toBe(coverAgain);
    expect((re.document.elements[0] as ImageElement).fit).toBe("contain");
    expect(re.dirty).toBe(true);
  });

  it("概要表（物件種別・id=overview）に被らない: 写真は overview 左端を越えない（要件①）", () => {
    // 要件⑤で新規図面の overview は右1/3（左端≈188）。写真はその左のみを使う。
    const before = makeState([overviewEl(188), imageEl(1), imageEl(2), imageEl(3), imageEl(4)]);
    const s = autoArrangePhotos(before);
    for (const img of images(s)) {
      expect(img.x + img.w).toBeLessThanOrEqual(188 + 0.001);
    }
    // overview 要素自体は不動（参照保存）。
    expect(s.document.elements[0]).toBe(before.document.elements[0]);
  });

  it("間取り図（floor-plan）は写真として扱わない＝整列対象外・参照ごと不動", () => {
    // floor-plan は type=image だがテンプレ枠。写真グリッドへ巻き込んではいけない
    // （要件④の追加時自動整列でも動かさない・autoBalanceLayout と同じ除外）。
    const floorPlan = {
      id: "floor-plan", type: "image", x: 10, y: 46, w: 32, h: 18, z: 1, src: SRC, fit: "contain",
    };
    const before = makeState([floorPlan, imageEl(1), imageEl(2)]);
    const after = autoArrangePhotos(before);
    // floor-plan は不動（参照保存）。
    expect(after.document.elements[0]).toBe(before.document.elements[0]);
    // 整列されるのはギャラリー写真2枚のみ。
    const galleryImgs = after.document.elements.filter(
      (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
    );
    expect(galleryImgs).toHaveLength(2);
    for (const img of galleryImgs) {
      expect(img.fit).toBe("contain");
      expectInZone(img, ZONE);
    }
    expectNoOverlaps(galleryImgs);
  });

  it("間取り図があるときは写真ゾーンを下へ寄せ、写真が間取り図に重ならない", () => {
    // floor-plan は左カラム上部（y=46）に固定。写真はその下に敷く（computeSpecSheetLayout と同じ）。
    const fpRect = { id: "floor-plan", type: "image", x: 10, y: 46, w: 32, h: 18, z: 1, src: SRC, fit: "contain" } as const;
    const s = autoArrangePhotos(makeState([fpRect, imageEl(1), imageEl(2), imageEl(3)]));
    const galleryImgs = s.document.elements.filter(
      (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
    );
    expect(galleryImgs).toHaveLength(3);
    const floorPlan = s.document.elements.find((e) => e.id === "floor-plan") as ImageElement;
    for (const img of galleryImgs) {
      expect(overlaps(img, floorPlan), "写真が間取り図に重なっている").toBe(false);
      // 間取り図の下端より下から始まる（縦位置を予約）。
      expect(img.y).toBeGreaterThanOrEqual(floorPlan.y + floorPlan.h - 0.001);
    }
  });

  it("移動距離を最小に: 既に各スロット付近にある写真は入れ替わらない（要件③）", () => {
    // 2枚を一度整列 → 位置を少しだけずらして再整列 → 各写真は元のスロットへ戻る（交差しない）。
    const arranged = autoArrangePhotos(makeState([imageEl(1), imageEl(2)]));
    const [a0, b0] = images(arranged);
    const nudged = {
      ...arranged,
      dirty: false,
      document: {
        ...arranged.document,
        elements: arranged.document.elements.map((e) => {
          if (e.id === "img-1") return { ...e, x: a0.x + 3, y: a0.y + 2 };
          if (e.id === "img-2") return { ...e, x: b0.x - 3, y: b0.y - 2 };
          return e;
        }),
      },
    };
    const re = autoArrangePhotos(nudged);
    const [a1, b1] = images(re);
    // img-1 は元スロット a0、img-2 は元スロット b0 に収束（順序保持）。
    expect(a1.x).toBeCloseTo(a0.x, 3);
    expect(a1.y).toBeCloseTo(a0.y, 3);
    expect(b1.x).toBeCloseTo(b0.x, 3);
    expect(b1.y).toBeCloseTo(b0.y, 3);
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
