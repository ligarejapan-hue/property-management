/**
 * TDD: editor-document 画像操作（写真管理・計画④）
 *   addImageElement: ギャラリーから選んだ写真を要素として追加
 *   editImage: 選択中画像の fit/焦点/角丸/alt を更新
 */
import { describe, it, expect } from "vitest";
import { type EditorState, addImageElement, editImage } from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type ImageElement,
} from "../document-schema";

const SRC = "/uploads/properties/a/1.jpg";

function makeDoc(elements: unknown[] = []): SalesSheetDocument {
  return parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
}
function makeState(elements: unknown[] = []): EditorState {
  return { document: makeDoc(elements), selectedId: null, dirty: false };
}
const imageEl = (over: Record<string, unknown> = {}) => ({
  id: "img-1", type: "image", x: 10, y: 10, w: 90, h: 60, z: 1, src: SRC, fit: "cover", ...over,
});
const textEl = (over: Record<string, unknown> = {}) => ({
  id: "t-1", type: "text", x: 0, y: 0, w: 20, h: 10, z: 1, content: "x", style: {}, ...over,
});

describe("addImageElement", () => {
  it("画像要素を末尾に追加し、自動選択・dirty 化する", () => {
    const s = addImageElement(makeState(), { id: "new-1", src: SRC });
    expect(s.dirty).toBe(true);
    expect(s.selectedId).toBe("new-1");
    const added = s.document.elements.at(-1)!;
    expect(added.type).toBe("image");
    expect(added.id).toBe("new-1");
    expect(added.type === "image" && added.src).toBe(SRC);
  });

  it("生成 document は schema 検証を通る（保存可能）", () => {
    const s = addImageElement(makeState([imageEl()]), { id: "new-1", src: SRC, alt: "外観" });
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
    const added = s.document.elements.at(-1) as ImageElement;
    expect(added.alt).toBe("外観");
  });

  it("ページ中央に既定サイズで配置し、z は既存最大+1", () => {
    const s = addImageElement(makeState([imageEl({ id: "e", z: 5 })]), { id: "new-1", src: SRC });
    const added = s.document.elements.at(-1)!;
    expect(added.z).toBe(6);
    expect(added.x).toBeCloseTo((297 - added.w) / 2, 1); // A4横中央
    expect(added.y).toBeCloseTo((210 - added.h) / 2, 1);
  });

  it("空ドキュメントでも z は 1 以上", () => {
    const s = addImageElement(makeState(), { id: "new-1", src: SRC });
    expect(s.document.elements.at(-1)!.z).toBeGreaterThanOrEqual(1);
  });

  it("安全でない src は追加しない（no-op・同一参照）", () => {
    const before = makeState();
    expect(addImageElement(before, { id: "x", src: "https://evil.example/x.jpg" })).toBe(before);
  });
});

describe("editImage", () => {
  it("fit/focalX/focalY/radiusMm/alt を更新し dirty 化", () => {
    const s = editImage(makeState([imageEl()]), "img-1", {
      fit: "contain", focalX: 20, focalY: 80, radiusMm: 3, alt: "外観",
    });
    const el = s.document.elements[0] as ImageElement;
    expect(el.fit).toBe("contain");
    expect(el.focalX).toBe(20);
    expect(el.focalY).toBe(80);
    expect(el.radiusMm).toBe(3);
    expect(el.alt).toBe("外観");
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("focalX/focalY は 0-100 にクランプ", () => {
    const s = editImage(makeState([imageEl()]), "img-1", { focalX: -10, focalY: 150 });
    const el = s.document.elements[0] as ImageElement;
    expect(el.focalX).toBe(0);
    expect(el.focalY).toBe(100);
  });

  it("非画像要素は no-op（同一参照）", () => {
    const s = makeState([textEl()]);
    expect(editImage(s, "t-1", { fit: "contain" })).toBe(s);
  });

  it("不明 id は no-op（同一参照）", () => {
    const s = makeState([imageEl()]);
    expect(editImage(s, "nope", { fit: "contain" })).toBe(s);
  });
});
