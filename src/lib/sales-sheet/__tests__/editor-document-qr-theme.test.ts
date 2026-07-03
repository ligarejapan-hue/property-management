/**
 * TDD: editor-document QR / テーマ操作（計画⑧）
 *   addQrElement: QR 要素を追加（content から dataURL を生成）
 *   editQr: QR の中身（content）を変更 → dataURL 再生成
 *   editTheme: 文書テーマ（fontFamily / accentColor）を変更
 */
import { describe, it, expect } from "vitest";
import {
  type EditorState,
  addQrElement,
  editQr,
  editTheme,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type QrElement,
} from "../document-schema";

const CONTENT = "https://example.com/properties/prop-1";

function makeDoc(elements: unknown[] = []): SalesSheetDocument {
  return parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#15324f" },
    elements,
  });
}
function makeState(elements: unknown[] = []): EditorState {
  return { document: makeDoc(elements), selectedId: null, dirty: false };
}
const textEl = () => ({
  id: "t-1", type: "text", x: 0, y: 0, w: 20, h: 10, z: 1, content: "x", style: {},
});

describe("addQrElement", () => {
  it("QR 要素を末尾に追加し、自動選択・dirty 化・content を保存する", () => {
    const s = addQrElement(makeState(), { id: "qr-1", content: CONTENT });
    expect(s.dirty).toBe(true);
    expect(s.selectedId).toBe("qr-1");
    const added = s.document.elements.at(-1) as QrElement;
    expect(added.type).toBe("qr");
    expect(added.content).toBe(CONTENT);
    expect(added.dataUrl.startsWith("data:image/")).toBe(true);
  });

  it("ページ中央に 30×30mm・z は既存最大+1", () => {
    const s = addQrElement(makeState([textEl()]), { id: "qr-1", content: CONTENT });
    const added = s.document.elements.at(-1)!;
    expect(added.w).toBe(30);
    expect(added.h).toBe(30);
    expect(added.z).toBe(2);
    expect(added.x).toBeCloseTo((297 - 30) / 2, 1);
    expect(added.y).toBeCloseTo((210 - 30) / 2, 1);
  });

  it("空 content は no-op（同一参照）", () => {
    const s = makeState();
    expect(addQrElement(s, { id: "qr-1", content: "" })).toBe(s);
    expect(addQrElement(s, { id: "qr-1", content: "  " })).toBe(s);
  });

  it("content は trim して保存する（QR の実エンコード値と一致）", () => {
    const s = addQrElement(makeState(), { id: "qr-1", content: `  ${CONTENT}  ` });
    const added = s.document.elements.at(-1) as QrElement;
    expect(added.content).toBe(CONTENT);
  });

  it("生成 document は schema 検証を通る（保存可能）", () => {
    const s = addQrElement(makeState([textEl()]), { id: "qr-1", content: CONTENT });
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });
});

describe("editQr", () => {
  const base = () => addQrElement(makeState(), { id: "qr-1", content: CONTENT });

  it("content 変更で dataURL を再生成し dirty 化", () => {
    const before = base();
    const beforeEl = before.document.elements[0] as QrElement;
    const s = editQr({ ...before, dirty: false }, "qr-1", {
      content: "https://example.com/other",
    });
    const el = s.document.elements[0] as QrElement;
    expect(el.content).toBe("https://example.com/other");
    expect(el.dataUrl).not.toBe(beforeEl.dataUrl);
    expect(el.dataUrl.startsWith("data:image/")).toBe(true);
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("空 content は no-op（同一参照・元の QR を保持）", () => {
    const before = base();
    expect(editQr(before, "qr-1", { content: "" })).toBe(before);
  });

  it("content は trim して保存する", () => {
    const s = editQr(base(), "qr-1", { content: "  https://example.com/x  " });
    expect((s.document.elements[0] as QrElement).content).toBe("https://example.com/x");
  });

  it("非 QR 要素は no-op（同一参照）", () => {
    const s = makeState([textEl()]);
    expect(editQr(s, "t-1", { content: CONTENT })).toBe(s);
  });

  it("不明 id は no-op（同一参照）", () => {
    const s = base();
    expect(editQr(s, "nope", { content: CONTENT })).toBe(s);
  });
});

describe("editTheme", () => {
  it("fontFamily / accentColor を更新し dirty 化", () => {
    const s = editTheme(makeState([textEl()]), {
      fontFamily: '"BIZ UDGothic",sans-serif',
      accentColor: "#d0331a",
    });
    expect(s.document.theme.fontFamily).toBe('"BIZ UDGothic",sans-serif');
    expect(s.document.theme.accentColor).toBe("#d0331a");
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("不正な fontFamily（; 注入）は無視して元の値を保つ", () => {
    const s = editTheme(makeState(), { fontFamily: "serif;position:fixed" });
    expect(s.document.theme.fontFamily).toBe("sans-serif");
  });

  it("不正な accentColor（url(...)）は無視して元の値を保つ", () => {
    const s = editTheme(makeState(), { accentColor: "url(javascript:alert(1))" });
    expect(s.document.theme.accentColor).toBe("#15324f");
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("要素と選択状態には触れない", () => {
    const before = { ...makeState([textEl()]), selectedId: "t-1" };
    const s = editTheme(before, { accentColor: "#000000" });
    expect(s.document.elements[0]).toBe(before.document.elements[0]);
    expect(s.selectedId).toBe("t-1");
  });
});
