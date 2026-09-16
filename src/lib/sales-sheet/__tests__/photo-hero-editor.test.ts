/**
 * photo-hero-editor.test.ts — 販売図面 第②段(発注者判断 2026-09-16)の編集操作。
 *
 *   - toggleHero       : 「この写真を大きく」。主役は常に1枚・もう一度押すと解除
 *   - autoArrangePhotos: 「写真を自動整列」= **大きさは保って位置だけ詰める**
 *   - autoBalanceLayout: 「レイアウト自動調整」= 主役1枚+残りは同じ大きさに**組み直す**
 *   - build-document   : 作成時は代表写真が主役(=開いた直後の整列し直しは不要)
 */
import { describe, it, expect } from "vitest";
import {
  type EditorState,
  autoArrangePhotos,
  autoBalanceLayout,
  toggleHero,
  addImageElement,
} from "../editor-document";
import { parseSalesSheetDocument, A4_LANDSCAPE, A4_PORTRAIT, type SalesSheetPage, type ImageElement } from "../document-schema";
import { CONSUMER_PHOTO_ZONE, heroGridCells } from "../layout-engine";
import { buildSaleHouseDocument } from "../build-document";

const Z = CONSUMER_PHOTO_ZONE;
const SRC = "/uploads/properties/a/1.jpg";

function makeState(
  elements: unknown[],
  page: SalesSheetPage = A4_LANDSCAPE,
  template: string | null = "consumer-2026-09",
): EditorState {
  return {
    document: parseSalesSheetDocument({
      page,
      theme: { fontFamily: "sans-serif", accentColor: "#1f4e79", ...(template ? { template } : {}) },
      elements,
    }),
    selectedId: null,
    dirty: false,
  };
}

const img = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: "image", x: 10, y: 20, w: 40, h: 30, z: 1, src: SRC, fit: "contain", ...over,
});
const images = (s: EditorState) => s.document.elements.filter((e): e is ImageElement => e.type === "image");
const byId = (s: EditorState, id: string) => images(s).find((e) => e.id === id)!;
const heroIds = (s: EditorState) => images(s).filter((e) => e.hero).map((e) => e.id);

/** 写真枠の中の相対座標で heroGridCells と一致しているか。 */
function expectHeroGrid(s: EditorState, heroIndex: number | null): void {
  const els = images(s);
  const cells = heroGridCells(els.length, heroIndex, Z.w, Z.h);
  els.forEach((el, i) => {
    expect(el.x, `${el.id}.x`).toBeCloseTo(Z.x + cells[i].x, 3);
    expect(el.y, `${el.id}.y`).toBeCloseTo(Z.y + cells[i].y, 3);
    expect(el.w, `${el.id}.w`).toBeCloseTo(cells[i].w, 3);
    expect(el.h, `${el.id}.h`).toBeCloseTo(cells[i].h, 3);
  });
}

describe("toggleHero — 「この写真を大きく」", () => {
  it("選んだ写真が主役になり、主役1枚+残りは同じ大きさに組み直す", () => {
    const s = makeState([img("a"), img("b"), img("c")]);
    const next = toggleHero(s, "b");
    expect(heroIds(next)).toEqual(["b"]);
    expectHeroGrid(next, 1);
    expect(next.dirty).toBe(true);
  });

  it("主役は常に1枚(別の写真を主役にすると前の主役は外れる)", () => {
    const s = toggleHero(makeState([img("a"), img("b"), img("c")]), "a");
    const next = toggleHero(s, "c");
    expect(heroIds(next)).toEqual(["c"]);
    expectHeroGrid(next, 2);
  });

  it("主役をもう一度押すと解除=全部同じ大きさ", () => {
    const s = toggleHero(makeState([img("a"), img("b"), img("c")]), "a");
    const next = toggleHero(s, "a");
    expect(heroIds(next)).toEqual([]);
    expectHeroGrid(next, null);
  });

  it("写真は切らずに全体を見せる(fit:contain)", () => {
    const next = toggleHero(makeState([img("a", { fit: "cover" }), img("b", { fit: "cover" })]), "a");
    images(next).forEach((e) => expect(e.fit).toBe("contain"));
  });

  it("写真以外・存在しない id は同一参照", () => {
    const s = makeState([img("a"), { id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, z: 1, content: "x", style: {} }]);
    expect(toggleHero(s, "t")).toBe(s);
    expect(toggleHero(s, "nope")).toBe(s);
  });

  it("旧ひな型・A4横以外は同一参照", () => {
    const legacy = makeState([img("a"), img("b")], A4_LANDSCAPE, null);
    expect(toggleHero(legacy, "a")).toBe(legacy);
    const portrait = makeState([img("a"), img("b")], A4_PORTRAIT);
    expect(toggleHero(portrait, "a")).toBe(portrait);
  });
});

describe("autoArrangePhotos — 大きさは保って位置だけ詰める", () => {
  it("手で変えた大きさは変えない", () => {
    const s = makeState([img("a", { w: 90, h: 70 }), img("b", { w: 30, h: 22 }), img("c", { w: 30, h: 22 })]);
    const next = autoArrangePhotos(s);
    expect(byId(next, "a").w).toBeCloseTo(90);
    expect(byId(next, "a").h).toBeCloseTo(70);
    expect(byId(next, "b").w).toBeCloseTo(30);
    expect(byId(next, "c").h).toBeCloseTo(22);
  });

  it("写真枠の左上から詰める(主役があれば主役が先頭)", () => {
    const s = makeState([img("a", { w: 30, h: 22 }), img("b", { w: 90, h: 70, hero: true })]);
    const next = autoArrangePhotos(s);
    expect(byId(next, "b").x).toBeCloseTo(Z.x);
    expect(byId(next, "b").y).toBeCloseTo(Z.y);
  });

  it("2回目は同一参照(冪等)", () => {
    const once = autoArrangePhotos(makeState([img("a", { w: 90, h: 70 }), img("b")]));
    expect(autoArrangePhotos(once)).toBe(once);
  });

  it("追加した写真は、既にある『主役以外の写真』と同じ大きさで末尾に入る", () => {
    const base = makeState([img("a", { w: 100, h: 75, hero: true }), img("b", { w: 36, h: 27 })]);
    const added = addImageElement(base, { id: "new", src: SRC });
    const next = autoArrangePhotos(added, { appendedId: "new" });
    expect(byId(next, "new").w).toBeCloseTo(36);
    expect(byId(next, "new").h).toBeCloseTo(27);
    // 既存の大きさは保つ
    expect(byId(next, "a").w).toBeCloseTo(100);
  });

  it("主役以外の写真が無いときの追加は、主役1枚+残りの格子の大きさで入る", () => {
    const base = makeState([img("a", { w: 100, h: 75, hero: true })]);
    const added = addImageElement(base, { id: "new", src: SRC });
    const next = autoArrangePhotos(added, { appendedId: "new" });
    const cell = heroGridCells(2, 0, Z.w, Z.h)[1];
    expect(byId(next, "new").w).toBeCloseTo(cell.w);
    expect(byId(next, "new").h).toBeCloseTo(cell.h);
  });

  it("旧ひな型・写真なしは同一参照", () => {
    const legacy = makeState([img("a")], A4_LANDSCAPE, null);
    expect(autoArrangePhotos(legacy)).toBe(legacy);
    const none = makeState([]);
    expect(autoArrangePhotos(none)).toBe(none);
  });
});

describe("autoBalanceLayout — 主役1枚+残りは同じ大きさに組み直す", () => {
  it("主役があれば主役の形に戻す(手で変えた大きさはリセット)", () => {
    const s = makeState([img("a", { w: 20, h: 15 }), img("b", { w: 110, h: 90, hero: true }), img("c")]);
    const next = autoBalanceLayout(s);
    expectHeroGrid(next, 1);
  });

  it("主役が無ければ全部同じ大きさ", () => {
    const s = makeState([img("a", { w: 20, h: 15 }), img("b", { w: 110, h: 90 })]);
    expectHeroGrid(autoBalanceLayout(s), null);
  });
});

describe("build-document — 作成時は代表写真が主役", () => {
  const base = {
    property: { address: "神奈川県横浜市港北区日吉4-5-6", occupancyStatus: "vacant" },
  };

  it("代表写真(1枚目)に主役の印が付き、主役1枚+残りの形で置かれる", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      photos: [{ fileUrl: "/uploads/a.jpg" }, { fileUrl: "/uploads/b.jpg" }, { fileUrl: "/uploads/c.jpg" }],
    } as never);
    const s: EditorState = { document: doc, selectedId: null, dirty: false };
    expect(heroIds(s)).toEqual(["photo-1"]);
    expectHeroGrid(s, 0);
  });

  it("間取り図も写真の仲間として同じ大きさで並ぶ(主役にはならない)", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      photos: [{ fileUrl: "/uploads/a.jpg" }, { fileUrl: "/uploads/b.jpg" }],
      floorPlanImage: { fileUrl: "/uploads/plan.png" },
    } as never);
    const s: EditorState = { document: doc, selectedId: null, dirty: false };
    expect(heroIds(s)).toEqual(["photo-1"]);
    expect(byId(s, "floor-plan").hero).toBeUndefined();
    expectHeroGrid(s, 0);
  });

  it("写真が無く間取り図だけなら主役なし", () => {
    const doc = buildSaleHouseDocument({ ...base, photos: [], floorPlanImage: { fileUrl: "/uploads/plan.png" } } as never);
    const s: EditorState = { document: doc, selectedId: null, dirty: false };
    expect(heroIds(s)).toEqual([]);
  });

  it("作成直後の配置は「写真を自動整列」を押しても変わらない(開いた直後の整列し直しは不要)", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      photos: [{ fileUrl: "/uploads/a.jpg" }, { fileUrl: "/uploads/b.jpg" }, { fileUrl: "/uploads/c.jpg" }],
    } as never);
    const s: EditorState = { document: doc, selectedId: null, dirty: false };
    // 位置も含めて1/1000mmまで同じ=変更ゼロなので同一参照が返る(未保存にもならない)。
    const arranged = autoArrangePhotos(s);
    expect(arranged).toBe(s);
  });
});

describe("主役の印は保存しても消えない", () => {
  it("図面データの検証(保存の入口)を通しても hero:true が残る", () => {
    const s = toggleHero(makeState([img("a"), img("b")]), "b");
    const reparsed = parseSalesSheetDocument(JSON.parse(JSON.stringify(s.document)));
    const b = reparsed.elements.find((e) => e.id === "b");
    expect(b?.type === "image" && b.hero).toBe(true);
  });

  it("主役の印が無い保存済みの図面も従来どおり読める", () => {
    const reparsed = parseSalesSheetDocument(JSON.parse(JSON.stringify(makeState([img("a")]).document)));
    const a = reparsed.elements.find((e) => e.id === "a");
    expect(a?.type === "image" && a.hero).toBeUndefined();
  });
});
