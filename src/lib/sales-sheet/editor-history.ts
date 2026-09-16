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
