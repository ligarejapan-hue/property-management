/**
 * editor-history.ts
 *
 * エディタの「元に戻す/やり直す」を担う純 reducer。SalesSheetEditor は
 * useReducer(editorHistoryReducer) でこれを回す(reducer 純=StrictMode二重呼出し安全)。
 *
 * - document の参照が変わった編集だけを履歴に積む(選択変更・保存フラグは積まない)。
 * - undo/redo は document を丸ごと入れ替え、selectedId は復元先に存在しなければ null。
 * - 履歴上限 HISTORY_LIMIT(古い方から捨てる)。redo 枝は新規編集でクリア。
 */

import type { SalesSheetDocument } from "./document-schema";
import type { EditorState } from "./editor-document";

/** 履歴の最大保持数(それ以上は古い方から捨てる)。 */
export const HISTORY_LIMIT = 50;

export interface HistoryState {
  editor: EditorState;
  past: SalesSheetDocument[];
  future: SalesSheetDocument[];
}

export type HistoryAction =
  | { type: "edit"; fn: (prev: EditorState) => EditorState }
  /**
   * 履歴に積まない土台の差し替え(開いた直後の初期整列など「読み込みの続き」)。
   * 編集として積むと、元に戻す→保存で作成直後のグリッドが意図的な配置として保存され、
   * 次に開いたときにまた整列される=ユーザーの選択が効かない(@codex #432 P2)。
   */
  | {
      type: "rebase";
      fn: (prev: EditorState) => EditorState;
      /**
       * 履歴に残っている古い版の写し替え。写真の読み込みが終わる前に別の箇所を編集して
       * いると past(先に元に戻していれば future)に整列前のグリッドが残り、そこへ戻って
       * 保存すると次に開いたときにまた整列される堂々巡りになる。同じ写し替えを履歴にも当てる。
       */
      mapSnapshot?: (doc: SalesSheetDocument) => SalesSheetDocument;
    }
  | { type: "undo" }
  | { type: "redo" };

export function initHistoryState(editor: EditorState): HistoryState {
  return { editor, past: [], future: [] };
}

/** 復元先 document に selectedId の要素が無ければ選択を解除する。 */
function reconcileSelection(
  doc: SalesSheetDocument,
  selectedId: string | null,
): string | null {
  if (selectedId === null) return null;
  return doc.elements.some((e) => e.id === selectedId) ? selectedId : null;
}

/** 履歴の版を写し替える。1つも変わらなければ元の配列を同一参照で返す。 */
function mapSnapshots(
  docs: SalesSheetDocument[],
  map?: (doc: SalesSheetDocument) => SalesSheetDocument,
): SalesSheetDocument[] {
  if (!map) return docs;
  let changed = false;
  const out = docs.map((d) => {
    const n = map(d);
    if (n !== d) changed = true;
    return n;
  });
  return changed ? out : docs;
}

export function editorHistoryReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "edit": {
      const next = action.fn(state.editor);
      if (next === state.editor) return state; // no-op は履歴も状態も不変
      if (next.document === state.editor.document) {
        // 選択変更・dirty/保存フラグのみ=履歴に積まない
        return { ...state, editor: next };
      }
      return {
        editor: next,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.editor.document],
        future: [],
      };
    }
    case "rebase": {
      const next = action.fn(state.editor);
      // 現在の版が変わらなかった=差し替える理由が無かった(門番が止めた)。履歴も触らない。
      // ここで履歴だけ写し替えると、元に戻した先が勝手に差し替わる(@codex #432 P2)。
      if (next === state.editor) return state;
      // 積まない・捨てない。ただし履歴に残った古い版には同じ写し替えを当てる。
      return {
        editor: next,
        past: mapSnapshots(state.past, action.mapSnapshot),
        future: mapSnapshots(state.future, action.mapSnapshot),
      };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const doc = state.past[state.past.length - 1];
      return {
        editor: {
          document: doc,
          selectedId: reconcileSelection(doc, state.editor.selectedId),
          dirty: true,
        },
        past: state.past.slice(0, -1),
        future: [state.editor.document, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const doc = state.future[0];
      return {
        editor: {
          document: doc,
          selectedId: reconcileSelection(doc, state.editor.selectedId),
          dirty: true,
        },
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.editor.document],
        future: state.future.slice(1),
      };
    }
  }
}
