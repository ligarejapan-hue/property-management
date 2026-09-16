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

// @codex #432 P2: 開いた直後の初期整列は「編集」ではなく「読み込みの続き」。
// 履歴に積むと、元に戻す→保存で作成直後のグリッドが意図的な配置として保存され、
// 次に開いたときにまた整列されてしまう(ユーザーの選択が効かない)。
describe("rebase — 履歴に積まない土台の差し替え", () => {
  const rebaseTo = (doc: SalesSheetDocument) => ({
    type: "rebase" as const,
    fn: (prev: EditorState): EditorState => ({ ...prev, dirty: true, document: doc }),
  });

  it("past に積まない=元に戻す先が増えない", () => {
    const a = makeDoc([textEl("a")]);
    const b = makeDoc([textEl("b")]);
    const s = editorHistoryReducer(makeState(a), rebaseTo(b));
    expect(s.editor.document).toBe(b);
    expect(s.past).toEqual([]);
  });

  it("rebase の直後に元に戻しても何も起きない", () => {
    const a = makeDoc([textEl("a")]);
    const b = makeDoc([textEl("b")]);
    const s = editorHistoryReducer(makeState(a), rebaseTo(b));
    const undone = editorHistoryReducer(s, { type: "undo" });
    expect(undone.editor.document).toBe(b);
  });

  it("no-op(同一参照)なら状態も同一参照", () => {
    const a = makeDoc([textEl("a")]);
    const s0 = makeState(a);
    const s = editorHistoryReducer(s0, { type: "rebase", fn: (prev) => prev });
    expect(s).toBe(s0);
  });

  it("rebase の後の通常の編集は従来どおり履歴に積む", () => {
    const a = makeDoc([textEl("a")]);
    const b = makeDoc([textEl("b")]);
    const c = makeDoc([textEl("c")]);
    const s = editorHistoryReducer(makeState(a), rebaseTo(b));
    const s2 = editorHistoryReducer(s, editTo(c));
    expect(s2.past).toEqual([b]);
    expect(editorHistoryReducer(s2, { type: "undo" }).editor.document).toBe(b);
  });

  it("既に積まれた履歴は捨てない", () => {
    const a = makeDoc([textEl("a")]);
    const b = makeDoc([textEl("b")]);
    const c = makeDoc([textEl("c")]);
    const s = editorHistoryReducer(makeState(a), editTo(b));
    const s2 = editorHistoryReducer(s, rebaseTo(c));
    expect(s2.past).toEqual([a]);
  });
});

// @codex #432 P2(2巡目): 写真の読み込みが終わる前に別の箇所を編集していると、
// past(や future)に整列前のグリッドが残る。そこへ「元に戻す」で戻って保存すると、
// 次に開いたときにまた整列される堂々巡りになる。履歴の中の古い版も一緒に直す。
describe("rebase — 履歴に残った古い版も一緒に差し替える", () => {
  const a = makeDoc([textEl("a")]);
  const b = makeDoc([textEl("b")]);
  const arranged = makeDoc([textEl("arranged")]);
  /** 「整列前(a)なら整列後(arranged)にする」写し替え。 */
  const mapSnapshot = (doc: SalesSheetDocument) => (doc === a ? arranged : doc);
  const rebase = {
    type: "rebase" as const,
    fn: (prev: EditorState): EditorState => ({ ...prev, dirty: true, document: arranged }),
    mapSnapshot,
  };

  it("past に残った整列前の版が整列後に差し替わる=元に戻してもグリッドに戻らない", () => {
    const edited = editorHistoryReducer(makeState(a), editTo(b));
    const rebased = editorHistoryReducer(edited, rebase);
    expect(editorHistoryReducer(rebased, { type: "undo" }).editor.document).toBe(arranged);
  });

  it("先に元に戻していた場合(future 側)も差し替わる", () => {
    const edited = editorHistoryReducer(makeState(a), editTo(b));
    const undone = editorHistoryReducer(edited, { type: "undo" });
    const rebased = editorHistoryReducer(undone, rebase);
    expect(editorHistoryReducer(rebased, { type: "redo" }).editor.document).toBe(b);
    expect(rebased.editor.document).toBe(arranged);
  });

  it("写し替える版が無ければ履歴は同一参照のまま", () => {
    const edited = editorHistoryReducer(makeState(b), editTo(a));
    const past = edited.past;
    const rebased = editorHistoryReducer(edited, {
      type: "rebase",
      fn: (prev) => prev,
      mapSnapshot: (doc) => doc,
    });
    expect(rebased).toBe(edited);
    expect(rebased.past).toBe(past);
  });
});
