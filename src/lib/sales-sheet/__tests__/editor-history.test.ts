import { describe, it, expect } from "vitest";
import {
  editorHistoryReducer,
  initHistoryState,
  HISTORY_LIMIT,
  type HistoryState,
} from "../editor-history";
import type { EditorState } from "../editor-document";
import { parseSalesSheetDocument, type SalesSheetDocument } from "../document-schema";

function makeDoc(elements: unknown[] = []): SalesSheetDocument {
  return parseSalesSheetDocument({
    page: { width: 297, height: 210, orientation: "landscape" },
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
}
const textEl = (id: string) => ({
  id, type: "text", x: 10, y: 8, w: 100, h: 10, z: 1, content: "t", style: {},
});

function makeState(doc: SalesSheetDocument, selectedId: string | null = null): HistoryState {
  return initHistoryState({ document: doc, selectedId, dirty: false });
}

/** document を差し替える編集アクション。 */
const editTo = (doc: SalesSheetDocument) => ({
  type: "edit" as const,
  fn: (prev: EditorState): EditorState => ({ ...prev, dirty: true, document: doc }),
});

describe("editorHistoryReducer", () => {
  it("document が変わる編集は past に積み、future をクリア", () => {
    const d0 = makeDoc();
    const d1 = makeDoc([textEl("a")]);
    let s = makeState(d0);
    s = { ...s, future: [makeDoc([textEl("stale")])] }; // redo枝あり
    s = editorHistoryReducer(s, editTo(d1));
    expect(s.editor.document).toBe(d1);
    expect(s.past).toEqual([d0]);
    expect(s.future).toEqual([]);
  });

  it("no-op 編集(同一参照)は state ごと不変", () => {
    const s = makeState(makeDoc());
    expect(editorHistoryReducer(s, { type: "edit", fn: (p) => p })).toBe(s);
  });

  it("document 不変の編集(選択のみ)は履歴に積まない", () => {
    const s = makeState(makeDoc());
    const next = editorHistoryReducer(s, {
      type: "edit",
      fn: (p) => ({ ...p, selectedId: "x" }),
    });
    expect(next.editor.selectedId).toBe("x");
    expect(next.past).toEqual([]);
  });

  it("undo は直前 document へ戻し、current を future へ・dirty=true", () => {
    const d0 = makeDoc();
    const d1 = makeDoc([textEl("a")]);
    let s = makeState(d0);
    s = editorHistoryReducer(s, editTo(d1));
    s = editorHistoryReducer(s, { type: "undo" });
    expect(s.editor.document).toBe(d0);
    expect(s.editor.dirty).toBe(true);
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([d1]);
  });

  it("redo は undo の逆", () => {
    const d0 = makeDoc();
    const d1 = makeDoc([textEl("a")]);
    let s = makeState(d0);
    s = editorHistoryReducer(s, editTo(d1));
    s = editorHistoryReducer(s, { type: "undo" });
    s = editorHistoryReducer(s, { type: "redo" });
    expect(s.editor.document).toBe(d1);
    expect(s.past).toEqual([d0]);
    expect(s.future).toEqual([]);
  });

  it("空の past/future では undo/redo は不変(同一参照)", () => {
    const s = makeState(makeDoc());
    expect(editorHistoryReducer(s, { type: "undo" })).toBe(s);
    expect(editorHistoryReducer(s, { type: "redo" })).toBe(s);
  });

  it("undo で選択中の要素が消える場合は選択解除", () => {
    const d0 = makeDoc();
    const d1 = makeDoc([textEl("a")]);
    let s = initHistoryState({ document: d0, selectedId: null, dirty: false });
    s = editorHistoryReducer(s, editTo(d1));
    s = editorHistoryReducer(s, { type: "edit", fn: (p) => ({ ...p, selectedId: "a" }) });
    s = editorHistoryReducer(s, { type: "undo" }); // d0 に "a" は無い
    expect(s.editor.document).toBe(d0);
    expect(s.editor.selectedId).toBeNull();
  });

  it("履歴は HISTORY_LIMIT で頭打ち(古い方から捨てる)", () => {
    let s = makeState(makeDoc());
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      s = editorHistoryReducer(s, editTo(makeDoc([textEl(`e${i}`)])));
    }
    expect(s.past.length).toBe(HISTORY_LIMIT);
  });
});
