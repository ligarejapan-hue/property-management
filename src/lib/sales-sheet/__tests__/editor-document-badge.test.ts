/**
 * TDD: editor-document バッジ操作（バッジデザイナー・計画⑦）
 *   addBadgeElement: オリジナルバッジ要素を追加（既定色=テーマ accent・中央配置）
 *   editBadge: 選択中バッジの label/shape/bg/fg/fontSizePt を更新
 */
import { describe, it, expect } from "vitest";
import { type EditorState, addBadgeElement, editBadge } from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type BadgeElement,
} from "../document-schema";

const ACCENT = "#15324f";

function makeDoc(elements: unknown[] = []): SalesSheetDocument {
  return parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: ACCENT },
    elements,
  });
}
function makeState(elements: unknown[] = []): EditorState {
  return { document: makeDoc(elements), selectedId: null, dirty: false };
}
const badgeEl = (over: Record<string, unknown> = {}) => ({
  id: "b-1", type: "badge", x: 10, y: 10, w: 40, h: 12, z: 1,
  label: "新着", shape: "rounded", bg: "#d0331a", fg: "#ffffff", ...over,
});
const textEl = () => ({
  id: "t-1", type: "text", x: 0, y: 0, w: 20, h: 10, z: 1, content: "x", style: {},
});

describe("addBadgeElement", () => {
  it("バッジ要素を末尾に追加し、自動選択・dirty 化する", () => {
    const s = addBadgeElement(makeState(), { id: "new-1" });
    expect(s.dirty).toBe(true);
    expect(s.selectedId).toBe("new-1");
    const added = s.document.elements.at(-1)!;
    expect(added.type).toBe("badge");
    expect(added.id).toBe("new-1");
  });

  it("既定はテーマ accent 色の背景・白文字・角丸・プレースホルダーラベル", () => {
    const s = addBadgeElement(makeState(), { id: "new-1" });
    const added = s.document.elements.at(-1) as BadgeElement;
    expect(added.bg).toBe(ACCENT);
    expect(added.fg).toBe("#ffffff");
    expect(added.shape).toBe("rounded");
    expect(added.label.length).toBeGreaterThan(0);
  });

  it("label を指定できる", () => {
    const s = addBadgeElement(makeState(), { id: "new-1", label: "価格改定" });
    const added = s.document.elements.at(-1) as BadgeElement;
    expect(added.label).toBe("価格改定");
  });

  it("ページ中央に既定サイズで配置し、z は既存最大+1", () => {
    const s = addBadgeElement(makeState([badgeEl({ id: "e", z: 5 })]), { id: "new-1" });
    const added = s.document.elements.at(-1)!;
    expect(added.z).toBe(6);
    expect(added.x).toBeCloseTo((297 - added.w) / 2, 1); // A4横中央
    expect(added.y).toBeCloseTo((210 - added.h) / 2, 1);
    expect(added.w).toBeGreaterThan(0);
    expect(added.h).toBeGreaterThan(0);
  });

  it("空ドキュメントでも z は 1 以上", () => {
    const s = addBadgeElement(makeState(), { id: "new-1" });
    expect(s.document.elements.at(-1)!.z).toBeGreaterThanOrEqual(1);
  });

  it("生成 document は schema 検証を通る（保存可能）", () => {
    const s = addBadgeElement(makeState([textEl()]), { id: "new-1", label: "おすすめ" });
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });
});

describe("editBadge", () => {
  it("label/shape/bg/fg/fontSizePt を更新し dirty 化", () => {
    const s = editBadge(makeState([badgeEl()]), "b-1", {
      label: "オープンハウス", shape: "pill", bg: "#15324f", fg: "#ffff00", fontSizePt: 14,
    });
    const el = s.document.elements[0] as BadgeElement;
    expect(el.label).toBe("オープンハウス");
    expect(el.shape).toBe("pill");
    expect(el.bg).toBe("#15324f");
    expect(el.fg).toBe("#ffff00");
    expect(el.fontSizePt).toBe(14);
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("不正な色は無視する（他のフィールドは適用）", () => {
    const s = editBadge(makeState([badgeEl()]), "b-1", {
      label: "更新", bg: "url(javascript:alert(1))", fg: "expression(x)",
    });
    const el = s.document.elements[0] as BadgeElement;
    expect(el.label).toBe("更新");
    expect(el.bg).toBe("#d0331a"); // 元のまま
    expect(el.fg).toBe("#ffffff"); // 元のまま
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("fontSizePt が 0 以下なら無視する", () => {
    const s = editBadge(makeState([badgeEl({ fontSizePt: 10 })]), "b-1", { fontSizePt: 0 });
    const el = s.document.elements[0] as BadgeElement;
    expect(el.fontSizePt).toBe(10);
  });

  it("ribbon 形状にも変更できる", () => {
    const s = editBadge(makeState([badgeEl()]), "b-1", { shape: "ribbon" });
    expect((s.document.elements[0] as BadgeElement).shape).toBe("ribbon");
  });

  it("非バッジ要素は no-op（同一参照）", () => {
    const s = makeState([textEl()]);
    expect(editBadge(s, "t-1", { label: "x" })).toBe(s);
  });

  it("不明 id は no-op（同一参照）", () => {
    const s = makeState([badgeEl()]);
    expect(editBadge(s, "nope", { label: "x" })).toBe(s);
  });
});
