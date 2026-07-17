"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ImageElement, SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import type { EditorState, EditThemePatch } from "@/lib/sales-sheet/editor-document";
import { editorHistoryReducer, initHistoryState } from "@/lib/sales-sheet/editor-history";
import {
  selectElement,
  moveElement,
  resizeElement,
  resizeElementWithOrigin,
  bringToFront,
  sendToBack,
  editText,
  editImage,
  editBadge,
  editQr,
  editTheme,
  editTableRow,
  addTableRow,
  removeTableRow,
  addImageElement,
  addBadgeElement,
  addQrElement,
  autoArrangePhotos,
  autoBalanceLayout,
  setAsFloorPlan,
  unsetFloorPlan,
  commitFloorPlanGeometry,
  clampElementsToPage,
  editFooterData,
  deleteElement,
  markSavedIfCurrent,
  exportWithSaveGuard,
} from "@/lib/sales-sheet/editor-document";
import { EditorCanvas } from "./EditorCanvas";
import { ElementPanel } from "./ElementPanel";
import type { ElementPanelChange } from "./ElementPanel";
import { EditorToolbar } from "./EditorToolbar";
import { PhotoGalleryPanel } from "./PhotoGalleryPanel";
import { TransactionInfoDialog } from "./TransactionInfoDialog";
import { readFooterData } from "@/lib/sales-sheet/footer-band";
import { safeRandomId } from "@/lib/random-id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SalesSheetEditorInitial {
  /** 初期ドキュメント（スキーマ検証済み） */
  document: SalesSheetDocument;
  /** DB 上のシート ID */
  sheetId: string;
  /** 紐付く物件 ID */
  propertyId: string;
  /** 最終保存日時（ISO 文字列） */
  updatedAt: string;
}

export interface SalesSheetEditorProps {
  initial: SalesSheetEditorInitial;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default canvas zoom (0.75 = 75%).
 * Task G will add zoom-in/out controls and convert this to useState.
 */
const DEFAULT_ZOOM = 0.75;

/** Millimetres to pixels at 96 dpi (96 / 25.4). */
const MM_TO_PX = 96 / 25.4;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * SalesSheetEditor — "use client" shell (plan-3 Task E + Task F + Task G + Task H)
 *
 * Holds EditorState (document + selectedId + dirty) via useState.
 * Renders the EditorCanvas in a scrollable, scale-transformed stage.
 *
 * Task F: wires drag/resize callbacks → moveElement / resizeElement /
 *   bringToFront / sendToBack reducers.
 *
 * Task G: mounts ElementPanel in the right panel — geometry (x/y/w/h in mm),
 *   z-order, delete, and text editing (content / font / size / color).
 *   All panel changes flow through handleElementPanelChange → Task-D reducers.
 *
 * Task H: EditorToolbar with save (PUT + optimistic lock), export (POST blob),
 *   delete (DELETE + navigate). Dirty indicator.
 */
/**
 * セッション切れ検出(A4 UI総点検): 未認証時に API が /login へリダイレクト(res.redirected)または 401 を返した
 * のを見ずに res.json()/blob() すると、HTML を掴んで「Unexpected token '<' ... is not valid JSON」等の生エラーに
 * なり、再ログイン導線も無かった。分かりやすい再ログイン案内に変換する。
 */
function assertAuthedResponse(res: Response): void {
  if (res.status === 401 || res.redirected) {
    throw new Error("セッションが切れました。別タブでログインし直してから、もう一度お試しください");
  }
}

export function SalesSheetEditor({ initial }: SalesSheetEditorProps) {
  const router = useRouter();
  // EditorState + 元に戻す/やり直す履歴を単一の純 reducer(editorHistoryReducer)で管理。
  const [historyState, dispatch] = useReducer(
    editorHistoryReducer,
    // 開いた時点で用紙外にはみ出した要素(過去データ/編集事故で用紙下端の外などに残った
    // 見えない要素)を用紙内へ引き戻して選択・編集できるようにする。用紙内に収まっている
    // 図面は同一参照=変更なし(dirty のまま false)。はみ出しがあった時のみ dirty=true で
    // 保存を促す。
    clampElementsToPage({ document: initial.document, selectedId: null, dirty: false }),
    initHistoryState,
  );
  const editorState = historyState.editor;
  /** 既存ハンドラの互換シム: setEditorState(prev=>X) 相当を履歴 reducer 経由で行う。 */
  function setEditorState(fn: (prev: EditorState) => EditorState): void {
    dispatch({ type: "edit", fn });
  }
  const [savedAt, setSavedAt] = useState(initial.updatedAt);
  // Mirror savedAt in a ref so export (which may run right after an auto-save)
  // sends the LATEST persisted version, not the stale render-time closure.
  const savedAtRef = useRef(initial.updatedAt);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [txInfoOpen, setTxInfoOpen] = useState(false);

  // ── 元に戻す/やり直す ─────────────────────────────────────────────────────
  const canUndo = historyState.past.length > 0;
  const canRedo = historyState.future.length > 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // 入力欄へのフォーカス中はブラウザ既定の undo(テキスト取り消し)を妨げない。
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      ) {
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        dispatch({ type: "redo" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── 写真の実寸縦横比の計測(src→比のキャッシュ) ─────────────────────────────
  // 段組み詰めは写真の実寸比で枠を作る。ブラウザで naturalWidth/Height を読み(同一
  // オリジン /uploads・エディタで既に表示済みならキャッシュヒット)、id→比で渡す。
  const aspectCacheRef = useRef(new Map<string, number>());
  // 中央列(間取り図)の move/resize の最新操作トークン(連続ジェスチャで最新を勝たせる)。
  const floorPlanOpRef = useRef(0);

  function measureAspect(src: string): Promise<number | null> {
    const cached = aspectCacheRef.current.get(src);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const a = img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;
        if (a !== null) aspectCacheRef.current.set(src, a);
        resolve(a);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /** ギャラリー写真(floor-plan 除く image)の実寸比を id→比 で測る(失敗した写真は省く)。 */
  async function measureGalleryAspects(doc: SalesSheetDocument): Promise<Record<string, number>> {
    const targets = doc.elements.filter(
      (e): e is ImageElement => e.type === "image" && e.id !== "floor-plan",
    );
    const out: Record<string, number> = {};
    await Promise.all(
      targets.map(async (el) => {
        const a = await measureAspect(el.src);
        if (a !== null) out[el.id] = a;
      }),
    );
    return out;
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleSelect(id: string | null): void {
    setEditorState((prev) => selectElement(prev, id));
  }

  /** Dispatches moveElement reducer — called by EditorCanvas onDragEnd. */
  function handleMove(id: string, pos: { x: number; y: number }): void {
    // 中央列(間取り図)は幾何確定+写真リフローを1更新で行う専用経路へ(undo1回・反比例)。
    if (id === "floor-plan") {
      void commitFloorPlan({ mode: "move", x: pos.x, y: pos.y });
      return;
    }
    setEditorState((prev) => moveElement(prev, id, pos));
  }

  /** リサイズ確定 — サイズと(top/leftハンドルで動いた)原点を1回の更新で適用=
   *  「元に戻す」1回でリサイズ全体が戻る(位置とサイズが別履歴に割れない)。 */
  function handleResize(id: string, size: { w: number; h: number; x?: number; y?: number }): void {
    if (id === "floor-plan") {
      // どの向きのハンドルでも右端を概要表の左へアンカーし、左端が動く=写真が反比例で狭まる。
      void commitFloorPlan({ mode: "resize", w: size.w, h: size.h, y: size.y });
      return;
    }
    setEditorState((prev) =>
      size.x !== undefined && size.y !== undefined
        ? // サイズと原点の同時変更は一括クランプ(順次適用だと旧値でクランプされ歪む)。
          resizeElementWithOrigin(prev, id, { x: size.x, y: size.y, w: size.w, h: size.h })
        : resizeElement(prev, id, size),
    );
  }

  /** 中央列(間取り図)の move/resize を確定し、右端アンカー＋写真リフローを1更新で行う。
   *  実寸比は src 由来(位置非依存)なので確定前 document から測る。測定中に document が
   *  変わっていたら適用しない(遅延した整列で intervening な編集を上書きしない・@codex #298)。 */
  async function commitFloorPlan(geom: {
    mode: "resize" | "move";
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }): Promise<void> {
    // 最新操作トークン＋docAtCall ガードの併用(@codex #298):
    // - トークン: 未キャッシュ画像で連続ジェスチャしたとき、古い方を破棄し最新を勝たせる
    //   (先着が document を変える前に古いジェスチャを弾く→最新の docAtCall が有効なまま)。
    // - docAtCall: 測定待ちに undo/redo や他要素編集が入ったら適用しない(履歴/編集を壊さない)。
    const op = ++floorPlanOpRef.current;
    const docAtCall = editorState.document;
    const aspects = await measureGalleryAspects(docAtCall);
    if (op !== floorPlanOpRef.current) return; // 新しいジェスチャに追い越された(古い方)
    setEditorState((prev) =>
      prev.document === docAtCall ? commitFloorPlanGeometry(prev, geom, aspects) : prev,
    );
  }

  /** Dispatches the appropriate Task-D reducer for every ElementPanel change. */
  function handleElementPanelChange(change: ElementPanelChange): void {
    // 間取り図の指定/解除は実寸比を測ってから整列する async 経路へ委譲する。
    if (change.type === "setFloorPlan") {
      void handleSetFloorPlan();
      return;
    }
    if (change.type === "unsetFloorPlan") {
      void handleUnsetFloorPlan();
      return;
    }
    // 中央列(間取り図)の X/Y/幅/高さをパネルで編集した場合も、キャンバスのドラッグと同じ
    // アンカー＋写真リフロー経路へ通す(汎用 move/resize だと概要表に食い込む/写真が非連動・@codex #298)。
    if (editorState.selectedId === "floor-plan") {
      if (change.type === "move") {
        void commitFloorPlan({ mode: "move", x: change.x, y: change.y });
        return;
      }
      if (change.type === "resize") {
        void commitFloorPlan({ mode: "resize", w: change.w, h: change.h });
        return;
      }
      if (change.type === "delete") {
        // 中央列を削除したら写真を左2/3へ詰め直す(削除だけだと写真が狭いまま中央が空白・@codex #298)。
        void handleDeleteFloorPlan();
        return;
      }
    }
    setEditorState((prev) => {
      const id = prev.selectedId;
      if (!id) return prev;
      switch (change.type) {
        case "move":
          return moveElement(prev, id, { x: change.x, y: change.y });
        case "resize":
          return resizeElement(prev, id, { w: change.w, h: change.h });
        case "bringToFront":
          return bringToFront(prev, id);
        case "sendToBack":
          return sendToBack(prev, id);
        case "delete":
          return deleteElement(prev, id);
        case "editText":
          // 文字サイズ変更での自動再バランスは撤去（@codex P2 / review 3件が指摘）: レイアウトを
          // 駆動する概要表フォントは editText 対象外ゆえ、見出し等の text フォント変更では枠が
          // 最適化されず（固定高で見切れる）・手で動かした要素がグリッドへ戻る害だけが残るため。
          // 内容に合わせた再配置は明示的な「レイアウト自動調整」ボタン(handleAutoBalance)で行う。
          // ②(文字→枠最適化)を本来の形にするにはエンジンが text フォントを考慮する追加設計が要る（follow-up）。
          return editText(prev, id, change.patch);
        case "editImage":
          return editImage(prev, id, change.patch);

        case "editBadge":
          return editBadge(prev, id, change.patch);
        case "editQr":
          return editQr(prev, id, change.patch);
        case "editTableRow":
          return editTableRow(prev, id, change.index, change.patch);
        case "addTableRow":
          return addTableRow(prev, id);
        case "removeTableRow":
          return removeTableRow(prev, id, change.index);
      }
    });
  }

  /** ギャラリーで選んだ写真を新しい image 要素として追加し、その場で段組み詰めする（要件④）。 */
  async function handleAddImage(src: string, alt?: string): Promise<void> {
    // crypto.randomUUID は secure context 外(HTTP)で未定義ゆえフォールバック付き ID を使う。
    const id = safeRandomId();
    // 実寸比を先に測ってから、追加→整列を1回の state 更新で行う(中間配置のちらつきなし)。
    const docAtCall = editorState.document;
    const aspects = await measureGalleryAspects(docAtCall);
    const newAspect = await measureAspect(src);
    if (newAspect !== null) aspects[id] = newAspect;
    setEditorState((prev) => {
      const added = addImageElement(prev, { id, src, alt });
      // 計測待ちの間にユーザーが編集していたら、遅延した整列で上書きしない(追加のみ・
      // @codex #294 R3)。整列はボタンでいつでもやり直せる。
      if (prev.document !== docAtCall) return added;
      return autoArrangePhotos(added, { appendedId: id, aspects });
    });
  }

  /** 写真を写真ゾーンへワンボタン段組み詰めする（手動上書き可・元に戻すで復元可）。 */
  async function handleAutoArrange(): Promise<void> {
    const docAtCall = editorState.document;
    const aspects = await measureGalleryAspects(docAtCall);
    // 計測待ちの間に編集が入っていたら適用しない(古い前提の整列で上書きしない・
    // @codex #294 R3)。必要ならユーザーがもう一度押す。
    setEditorState((prev) => (prev.document === docAtCall ? autoArrangePhotos(prev, { aspects }) : prev));
  }

  /** 選択中の写真を中央列の間取り図/敷地図にする（実寸比を測って写真を図の左へ整列）。 */
  async function handleSetFloorPlan(): Promise<void> {
    const id = editorState.selectedId;
    if (!id) return;
    const doc = editorState.document;
    const aspects = await measureGalleryAspects(doc);
    const demotedId = safeRandomId();
    // 既存の間取り図がある場合は写真へ降格する＝そのまま写真ゾーンのモザイクに再合流する。
    // measureGalleryAspects は floor-plan を除外するため、降格後の実寸比を別途測って
    // demotedId で登録する（未登録だと旧・中央列枠の縦横比にフォールバックし余白/歪みが出る）。
    const existingFp = doc.elements.find(
      (e): e is ImageElement => e.id === "floor-plan" && e.type === "image",
    );
    if (existingFp) {
      const a = await measureAspect(existingFp.src);
      if (a !== null) aspects[demotedId] = a;
    }
    // 計測待ちの間に選択/編集/undo が入っていたら適用しない(古い前提で上書きしない・@codex #298)。
    // 選択変更は document 参照を変えないため、selectedId===id も併せて確認する。
    setEditorState((prev) =>
      prev.document === doc && prev.selectedId === id
        ? setAsFloorPlan(prev, id, demotedId, aspects)
        : prev,
    );
  }

  /** 中央列の間取り図/敷地図を通常の写真へ戻す（実寸比を測って写真を再整列）。 */
  async function handleUnsetFloorPlan(): Promise<void> {
    const doc = editorState.document;
    const aspects = await measureGalleryAspects(doc);
    const newId = safeRandomId();
    // 解除で写真へ戻る間取り図は measureGalleryAspects の対象外ゆえ、実寸比を測って newId で
    // 登録する（未登録だと中央列枠の縦横比でモザイク化され余白/歪みが出る）。
    const fp = doc.elements.find(
      (e): e is ImageElement => e.id === "floor-plan" && e.type === "image",
    );
    if (fp) {
      const a = await measureAspect(fp.src);
      if (a !== null) aspects[newId] = a;
    }
    // 計測待ちの間に編集/undo/選択変更が入っていたら適用しない(選択変更は document を変えない
    // ため selectedId==="floor-plan" のままかも確認・handleSetFloorPlan と対称・@codex #298)。
    setEditorState((prev) =>
      prev.document === doc && prev.selectedId === "floor-plan"
        ? unsetFloorPlan(prev, newId, aspects)
        : prev,
    );
  }

  /** 中央列(間取り図)を削除し、写真を左2/3(2列)へ詰め直す(@codex #298)。 */
  async function handleDeleteFloorPlan(): Promise<void> {
    const doc = editorState.document;
    const aspects = await measureGalleryAspects(doc);
    setEditorState((prev) =>
      prev.document === doc && prev.selectedId === "floor-plan"
        ? autoArrangePhotos(deleteElement(prev, "floor-plan"), { aspects })
        : prev,
    );
  }

  /** テンプレ全体を内容に合わせてワンボタン再バランスする（機能A）。
   *  中央列(間取り図)・概要表・見出し等を整え直したうえで、写真は残りスペースへモザイクで
   *  詰め直す（「写真を自動整列」と結果を揃える＝レイアウト自動調整でも写真がきれいに並ぶ）。 */
  async function handleAutoBalance(): Promise<void> {
    const docAtCall = editorState.document;
    const aspects = await measureGalleryAspects(docAtCall);
    // 計測待ちの間に編集/undo が入っていたら適用しない(古い前提で再バランスしない・@codex #298)。
    setEditorState((prev) =>
      prev.document === docAtCall ? autoArrangePhotos(autoBalanceLayout(prev), { aspects }) : prev,
    );
  }

  /** オリジナルバッジを追加する（バッジデザイナー・計画⑦）。 */
  function handleAddBadge(): void {
    // crypto.randomUUID は secure context 外(HTTP)で未定義ゆえフォールバック付き ID を使う。
    setEditorState((prev) => addBadgeElement(prev, { id: safeRandomId() }));
  }

  /** QR コードを追加する（計画⑧）。中身はプレースホルダー＝右パネルで書き換える。 */
  function handleAddQr(): void {
    setEditorState((prev) => addQrElement(prev, { id: safeRandomId(), content: "https://" }));
  }

  /** 文書テーマ（フォント/基調色）を変更する（計画⑧）。 */
  function handleThemeChange(patch: EditThemePatch): void {
    setEditorState((prev) => editTheme(prev, patch));
  }

  /**
   * Save current document via PUT; handles optimistic-lock 409.
   * Resolves `true` iff the editor ended CLEAN — i.e. no edit raced the in-flight
   * save (markSavedIfCurrent cleared dirty). Export uses this to avoid emitting a
   * stale file. The clean flag is read inside the state updater so it reflects the
   * latest committed state, not the stale render-time closure.
   */
  async function handleSave(): Promise<boolean> {
    // Capture the exact document being persisted so edits made while this
    // request is in flight are NOT marked clean when the response returns.
    const sentDocument = editorState.document;
    const res = await fetch(
      `/api/properties/${initial.propertyId}/sales-sheets/${initial.sheetId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: sentDocument, expectedUpdatedAt: savedAt }),
      },
    );
    if (res.status === 409) throw new Error("他で更新されました。再読込してください");
    assertAuthedResponse(res);
    if (!res.ok) throw new Error("保存に失敗しました");
    // セッション切れで HTML が返っても JSON.parse で落ちない(生エラーを出さず再ログイン案内にする)。
    const data = (await res.json().catch(() => null)) as { updatedAt: string } | null;
    if (!data || typeof data.updatedAt !== "string") {
      throw new Error("セッションが切れた可能性があります。別タブでログインし直してから保存してください");
    }
    setSavedAt(data.updatedAt);
    savedAtRef.current = data.updatedAt; // keep the export version check current
    return await new Promise<boolean>((resolve) => {
      setEditorState((prev) => {
        const next = markSavedIfCurrent(prev, sentDocument);
        resolve(!next.dirty); // cleaned iff no concurrent edit kept it dirty
        return next;
      });
    });
  }

  /** Export as PDF or PNG. Auto-saves first when dirty; aborts on a save race. */
  async function handleExport(format: "pdf" | "png"): Promise<void> {
    await exportWithSaveGuard({
      dirty: editorState.dirty,
      save: handleSave,
      doExport: async () => {
        // Send the loaded version so the route returns 409 if another user saved
        // since — avoids exporting a newer DB version than the on-screen design.
        const params = new URLSearchParams({ format, expectedUpdatedAt: savedAtRef.current });
        const res = await fetch(
          `/api/properties/${initial.propertyId}/sales-sheets/${initial.sheetId}/export?${params.toString()}`,
          { method: "POST" },
        );
        if (res.status === 409) throw new Error("他で更新されました。再読込してください");
        if (res.status === 503) throw new Error("PDF生成エンジン未準備");
        assertAuthedResponse(res);
        if (!res.ok) throw new Error("出力に失敗しました");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = format === "pdf" ? "販売図面.pdf" : "販売図面.png";
        a.click();
        URL.revokeObjectURL(url);
      },
    });
  }

  /** Delete design and navigate back to the property detail page. */
  async function handleDelete(): Promise<void> {
    const res = await fetch(
      `/api/properties/${initial.propertyId}/sales-sheets/${initial.sheetId}`,
      { method: "DELETE" },
    );
    assertAuthedResponse(res);
    if (!res.ok) throw new Error("削除に失敗しました");
    router.push(`/properties/${initial.propertyId}`);
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const { page } = editorState.document;

  // Paper pixel dimensions at zoom
  const scaledW = page.width * MM_TO_PX * DEFAULT_ZOOM;
  const scaledH = page.height * MM_TO_PX * DEFAULT_ZOOM;

  /** Selected element object (null when nothing is selected). */
  const selectedElement =
    editorState.selectedId != null
      ? (editorState.document.elements.find((e) => e.id === editorState.selectedId) ?? null)
      : null;

  return (
    <div className="flex flex-col h-full bg-neutral-200 dark:bg-zinc-900">
      {/* ── Toolbar — Task H ─────────────────────────────────────────── */}
      <EditorToolbar
        dirty={editorState.dirty}
        onUndo={() => dispatch({ type: "undo" })}
        canUndo={canUndo}
        onRedo={() => dispatch({ type: "redo" })}
        canRedo={canRedo}
        onSave={async () => {
          await handleSave();
        }}
        onExport={handleExport}
        onDelete={handleDelete}
        onAddPhoto={() => setGalleryOpen(true)}
        onAutoArrange={handleAutoArrange}
        onAutoBalance={handleAutoBalance}
        onAddBadge={handleAddBadge}
        onAddQr={handleAddQr}
        onOpenTransactionInfo={() => setTxInfoOpen(true)}
        canEditTransactionInfo={editorState.document.elements.some((e) => e.id === "footer-band")}
      />

      {/* ── 写真ギャラリー（写真管理・計画④） ─────────────────────────── */}
      {galleryOpen && (
        <PhotoGalleryPanel
          propertyId={initial.propertyId}
          onClose={() => setGalleryOpen(false)}
          onAddPhoto={handleAddImage}
        />
      )}

      {/* ── 取引情報（会社帯の物件別6項目）編集モーダル ─────────────────── */}
      {txInfoOpen && (
        <TransactionInfoDialog
          open
          initial={readFooterData(editorState.document.elements)}
          onClose={() => setTxInfoOpen(false)}
          onApply={(data) => {
            setEditorState((prev) => editFooterData(prev, data));
            setTxInfoOpen(false);
          }}
        />
      )}

      {/* ── Main split ───────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Canvas stage (scrollable, paper scaled to DEFAULT_ZOOM) */}
        <div className="flex-1 overflow-auto">
          <div
            className="flex items-start justify-center p-8"
            style={{ minWidth: scaledW + 64, minHeight: scaledH + 64 }}
          >
            {/*
             * Scale wrapper: keeps layout footprint equal to the scaled paper
             * while transform:scale renders the full-mm canvas at zoom ratio.
             */}
            <div
              data-canvas-stage
              style={{
                width: scaledW,
                height: scaledH,
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transformOrigin: "top left",
                  transform: `scale(${DEFAULT_ZOOM})`,
                }}
              >
                <EditorCanvas
                  document={editorState.document}
                  selectedId={editorState.selectedId}
                  onSelect={handleSelect}
                  onMove={handleMove}
                  onResize={handleResize}
                  mmToPx={MM_TO_PX}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Properties panel — Task G: ElementPanel (geometry + text editor) */}
        <div
          data-properties-panel
          className="w-64 shrink-0 border-l border-neutral-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-y-auto"
          aria-label="properties panel"
        >
          <ElementPanel
            element={selectedElement}
            onChange={handleElementPanelChange}
            theme={editorState.document.theme}
            onThemeChange={handleThemeChange}
          />
        </div>
      </div>
    </div>
  );
}

export default SalesSheetEditor;
