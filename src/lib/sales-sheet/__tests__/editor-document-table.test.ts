/**
 * TDD: editor-document 概要表の編集（計画⑧ 第2弾）
 *   editTableRow: 行の label / value を更新
 *   addTableRow: 末尾に空行を追加
 *   removeTableRow: 行を削除
 * 作成時にしか表へ入力できなかった方式Aの限界を解消し、
 * エディタで概要表を後から編集できるようにする。
 */
import { describe, it, expect } from "vitest";
import {
  type EditorState,
  editTableRow,
  addTableRow,
  removeTableRow,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type TableElement,
} from "../document-schema";

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
const tableEl = (over: Record<string, unknown> = {}) => ({
  id: "tbl-1", type: "table", x: 150, y: 22, w: 137, h: 160, z: 1,
  rows: [
    { label: "所在地", value: "東京都..." },
    { label: "価格", value: "5,000万円" },
  ],
  style: {},
  ...over,
});
const textEl = () => ({
  id: "t-1", type: "text", x: 0, y: 0, w: 20, h: 10, z: 1, content: "x", style: {},
});

const rows = (s: EditorState): { label: string; value: string }[] =>
  (s.document.elements[0] as TableElement).rows;

describe("editTableRow", () => {
  it("行の label / value を更新し dirty 化", () => {
    const s = editTableRow(makeState([tableEl()]), "tbl-1", 1, {
      label: "販売価格", value: "4,800万円",
    });
    expect(rows(s)[1]).toEqual({ label: "販売価格", value: "4,800万円" });
    expect(rows(s)[0]).toEqual({ label: "所在地", value: "東京都..." });
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("片方のフィールドだけ更新できる", () => {
    const s = editTableRow(makeState([tableEl()]), "tbl-1", 0, { value: "大阪府..." });
    expect(rows(s)[0]).toEqual({ label: "所在地", value: "大阪府..." });
  });

  it("範囲外 index は no-op（同一参照）", () => {
    const s = makeState([tableEl()]);
    expect(editTableRow(s, "tbl-1", 2, { value: "x" })).toBe(s);
    expect(editTableRow(s, "tbl-1", -1, { value: "x" })).toBe(s);
  });

  it("非 table 要素 / 不明 id は no-op（同一参照）", () => {
    const s = makeState([textEl(), tableEl({ id: "tbl-2" })]);
    expect(editTableRow(s, "t-1", 0, { value: "x" })).toBe(s);
    expect(editTableRow(s, "nope", 0, { value: "x" })).toBe(s);
  });
});

describe("addTableRow", () => {
  it("末尾に空行を追加し dirty 化", () => {
    const s = addTableRow(makeState([tableEl()]), "tbl-1");
    expect(rows(s)).toHaveLength(3);
    expect(rows(s)[2]).toEqual({ label: "", value: "" });
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("非 table 要素 / 不明 id は no-op（同一参照）", () => {
    const s = makeState([textEl()]);
    expect(addTableRow(s, "t-1")).toBe(s);
    expect(addTableRow(s, "nope")).toBe(s);
  });
});

describe("removeTableRow", () => {
  it("指定行を削除し dirty 化（他の行は保持）", () => {
    const s = removeTableRow(makeState([tableEl()]), "tbl-1", 0);
    expect(rows(s)).toHaveLength(1);
    expect(rows(s)[0]).toEqual({ label: "価格", value: "5,000万円" });
    expect(s.dirty).toBe(true);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("最後の 1 行も削除できる（空の表は schema 上有効）", () => {
    const one = tableEl({ rows: [{ label: "a", value: "b" }] });
    const s = removeTableRow(makeState([one]), "tbl-1", 0);
    expect(rows(s)).toHaveLength(0);
    expect(salesSheetDocumentSchema.safeParse(s.document).success).toBe(true);
  });

  it("範囲外 index は no-op（同一参照）", () => {
    const s = makeState([tableEl()]);
    expect(removeTableRow(s, "tbl-1", 2)).toBe(s);
    expect(removeTableRow(s, "tbl-1", -1)).toBe(s);
  });

  it("非 table 要素 / 不明 id は no-op（同一参照）", () => {
    const s = makeState([textEl()]);
    expect(removeTableRow(s, "t-1", 0)).toBe(s);
    expect(removeTableRow(s, "nope", 0)).toBe(s);
  });
});
