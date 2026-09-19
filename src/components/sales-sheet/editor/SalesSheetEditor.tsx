"use client";

import { useEffect, useMemo, useReducer, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { isConsumerTemplate } from "@/lib/sales-sheet/document-schema";
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
  addMapQrElement,
  autoArrangePhotos,
  toggleHero,
  autoBalanceLayout,
  setAsFloorPlan,
  unsetFloorPlan,
  clampElementsToPage,
  editFooterData,
  deleteElement,
  markSavedIfCurrent,
  exportWithSaveGuard,
  findTextTableOverlaps,
  resolveTextTableOverlapsInDocument,
  resolveOverlapsInState,
} from "@/lib/sales-sheet/editor-document";
import { EditorCanvas } from "./EditorCanvas";
import { ElementPanel } from "./ElementPanel";
import type { ElementPanelChange } from "./ElementPanel";
import { EditorToolbar, LEGACY_TEMPLATE_NOTE } from "./EditorToolbar";
import { PhotoGalleryPanel } from "./PhotoGalleryPanel";
import { TransactionInfoDialog } from "./TransactionInfoDialog";
import { readFooterData } from "@/lib/sales-sheet/footer-band";
import { safeRandomId } from "@/lib/random-id";
import { overflowingTableIds } from "./table-overflow";
import { WritebackNotice } from "./WritebackNotice";

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
  /** 物件の住所（地図QR のリンク生成に使う。未登録なら空/undefined でボタン無効）。 */
  propertyAddress?: string;
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

/** 表の文字が枠に入りきらないときの注意(仕様書 §4.8)。PDFには出さない。 */
const TABLE_OVERFLOW_WARNING = "表の文字が入りきっていません(項目を減らすか、枠を広げてください)";

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

/**
 * API が返した理由文を取り出す (総点検 2026-07-27)。
 *
 * ⚠これが無いと、保存・出力の失敗が理由不明の「保存に失敗しました」になる。
 * 販売図面の保存は用紙外・画像枚数・画像サイズ・権限で弾かれ、サーバーは
 * 「入力内容に問題があります: elements.3.x: …」のように**直し方が判る文言**を
 * 返しているのに、画面はそれを捨てて汎用文言だけ出していた。何が悪いのか
 * 判らないまま同じ操作を繰り返す(= 実質詰む)状態だった。
 *
 * セッション切れで HTML が返る場合もあるため、JSON でなければ fallback に倒す。
 * 生のレスポンス本文をそのまま出さない(message フィールドだけを読む)。
 */
async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: unknown } }
    | null;
  const message = body?.error?.message;
  return typeof message === "string" && message.trim() !== ""
    ? message
    : fallback;
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

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleSelect(id: string | null): void {
    setEditorState((prev) => selectElement(prev, id));
  }

  /** Dispatches moveElement reducer — called by EditorCanvas onDragEnd. */
  function handleMove(id: string, pos: { x: number; y: number }): void {
    setEditorState((prev) => moveElement(prev, id, pos));
  }

  /** リサイズ確定 — サイズと(top/leftハンドルで動いた)原点を1回の更新で適用=
   *  「元に戻す」1回でリサイズ全体が戻る(位置とサイズが別履歴に割れない)。 */
  function handleResize(id: string, size: { w: number; h: number; x?: number; y?: number }): void {
    setEditorState((prev) =>
      size.x !== undefined && size.y !== undefined
        ? // サイズと原点の同時変更は一括クランプ(順次適用だと旧値でクランプされ歪む)。
          resizeElementWithOrigin(prev, id, { x: size.x, y: size.y, w: size.w, h: size.h })
        : resizeElement(prev, id, size),
    );
  }

  /** Dispatches the appropriate Task-D reducer for every ElementPanel change. */
  function handleElementPanelChange(change: ElementPanelChange): void {
    // 間取り図の指定/解除は実寸比を測ってから整列する async 経路へ委譲する。
    if (change.type === "setFloorPlan") {
      handleSetFloorPlan();
      return;
    }
    if (change.type === "unsetFloorPlan") {
      handleUnsetFloorPlan();
      return;
    }
    if (change.type === "toggleHero") {
      setEditorState((prev) => (prev.selectedId ? toggleHero(prev, prev.selectedId) : prev));
      return;
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

  /**
   * ギャラリーで選んだ写真を追加し、その場で詰め直す。既にある写真の大きさは変えず、
   * 追加した写真は「主役以外の写真」と同じ大きさで末尾に入る(発注者判断 2026-09-16)。
   * 並べ方は写真の縦横に左右されない(fit:contain)ため、実寸比の計測は要らない=同期。
   */
  function handleAddImage(src: string, alt?: string): void {
    // crypto.randomUUID は secure context 外(HTTP)で未定義ゆえフォールバック付き ID を使う。
    const id = safeRandomId();
    setEditorState((prev) => autoArrangePhotos(addImageElement(prev, { id, src, alt }), { appendedId: id }));
  }

  /** 「写真を自動整列」= 大きさは保って位置だけ詰める(元に戻すで復元可)。 */
  function handleAutoArrange(): void {
    setEditorState((prev) => autoArrangePhotos(prev));
  }

  /** 選択中の写真を間取り図にする。 */
  function handleSetFloorPlan(): void {
    const id = editorState.selectedId;
    if (!id) return;
    const demotedId = safeRandomId();
    setEditorState((prev) => (prev.selectedId !== id ? prev : setAsFloorPlan(prev, id, demotedId)));
  }

  /** 間取り図を通常の写真へ戻す。 */
  function handleUnsetFloorPlan(): void {
    const newId = safeRandomId();
    setEditorState((prev) => (prev.selectedId !== "floor-plan" ? prev : unsetFloorPlan(prev, newId)));
  }

  /**
   * 「レイアウト自動調整」= 紙面全体を内容に合わせて組み直す。写真は主役1枚+残りは
   * 同じ大きさに戻す(手で変えた大きさもリセット=大きさを作り直したいときの逃げ道)。
   */
  function handleAutoBalance(): void {
    setEditorState((prev) => autoBalanceLayout(prev));
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

  /** 物件の場所を Google マップ検索する QR を、会社帯の右端に差し込む。 */
  const canAddMapQr = !!initial.propertyAddress && initial.propertyAddress.trim() !== "";
  function handleAddMapQr(): void {
    if (!canAddMapQr) return;
    setEditorState((prev) => addMapQrElement(prev, { address: initial.propertyAddress ?? "" }));
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
    if (!res.ok) throw new Error(await apiErrorMessage(res, "保存に失敗しました"));
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
        // ⚠503 を client 側の固定文言に潰さない（総点検P3）。サーバは混雑
        // (RENDER_BUSY=「混み合っています。少し待って再実行」)と未準備
        // (PDF_UNAVAILABLE=サーバ未設定)を別文言で返す。先回りして固定文言に
        // 上書きすると、数秒待てば直る混雑まで恒久障害に見える。
        assertAuthedResponse(res);
        if (!res.ok) throw new Error(await apiErrorMessage(res, "出力に失敗しました"));
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
    if (!res.ok) throw new Error(await apiErrorMessage(res, "削除に失敗しました"));
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

  const isConsumer = isConsumerTemplate(editorState.document);

  // B-8: 文字・表どうしの重なりは自動整列/自動調整では解消されない(手動配置の
  // 尊重)ため、常時検知して出力前に気付けるよう控えめに注意を出す。
  const textTableOverlapCount = useMemo(
    () => findTextTableOverlaps(editorState.document).length,
    [editorState.document],
  );
  // 描画された紙面(data-canvas-stage)を測るための ref。表(data-sheet-table)は
  // この配下に描かれる。
  const canvasStageRef = useRef<HTMLDivElement>(null);
  const [overflowTableIds, setOverflowTableIds] = useState<string[]>([]);
  // 表の文字が枠からあふれていないか(仕様書 §4.8)。重なりとは別軸の注意。
  // 見積りではなく実際の描画(data-sheet-table・ResizeObserver)を測る(F2)。
  useEffect(() => {
    const container = canvasStageRef.current;
    if (!container) return;
    // jsdom(テスト環境)には ResizeObserver が無い。無ければ何もしない
    // (見積りへは戻さない=「表の入りきり」は実測のみで判定する・F2)。
    if (typeof ResizeObserver === "undefined") return;
    const wrappers = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sheet-table]"),
    );
    if (wrappers.length === 0) return;
    // 外枠 div(overflow:hidden・箱サイズ固定)自体はコンテンツが伸びても
    // 自分の大きさは変わらないため ResizeObserver は発火しない。中身の
    // <table>(自然な高さで伸びる)を観測し、コールバックで外枠の
    // scrollHeight/clientHeight を読む。
    const observer = new ResizeObserver(() => {
      const boxes = wrappers.map((w) => ({
        id: w.getAttribute("data-sheet-table") ?? "",
        scrollHeight: w.scrollHeight,
        clientHeight: w.clientHeight,
      }));
      const ids = overflowingTableIds(boxes);
      setOverflowTableIds((prev) => (prev.join(",") === ids.join(",") ? prev : ids));
    });
    for (const wrapper of wrappers) {
      const table = wrapper.querySelector("table");
      if (table) observer.observe(table);
    }
    return () => observer.disconnect();
  }, [editorState.document]);
  const tableOverflowCount = overflowTableIds.length;
  const layoutWarning =
    [
      textTableOverlapCount > 0
        ? `文字・表が重なっています(${textTableOverlapCount}箇所)。出力にもそのまま写るため、ドラッグで位置を調整してください`
        : null,
      tableOverflowCount > 0 ? TABLE_OVERFLOW_WARNING : null,
    ]
      .filter(Boolean)
      .join("／") || null;
  // B-8 案A (2026-08-23 発注者判断): ボタンを押したときだけ自動で直す。
  // 勝手には一切動かさない(「手動配置の尊重」との両立)。結果は履歴に乗る=
  // 「元に戻す」で丸ごと戻せる。
  // ⚠通知は**適用後の document に紐付ける**(@codex #403 R1 P2)。文字列だけを
  //   state に持つと、直後の「元に戻す」やドラッグで重なりが復活しても
  //   「直しました」が残り、新しい警告と矛盾した表示になる。
  //   document の参照が変わったら表示しない=導出で消える(effect での消去は
  //   eslint set-state-in-effect と衝突するため採らない)。
  const [autoFix, setAutoFix] = useState<{
    doc: SalesSheetDocument;
    text: string;
  } | null>(null);
  const autoFixNotice =
    autoFix && autoFix.doc === editorState.document ? autoFix.text : null;
  const handleAutoFixOverlaps = useCallback(() => {
    // 概要(何件直せたか)は純関数を**表示用に**先に走らせて作る。決定的なので
    // 履歴へ積む適用と必ず同じ結果になる。
    const captured = editorState.document;
    const r = resolveTextTableOverlapsInDocument(captured);
    if (r.document === captured) {
      setAutoFix(
        r.unresolved > 0
          ? {
              doc: captured,
              text: "自動では直せない重なりです(表どうし等)。ドラッグで調整してください",
            }
          : null,
      );
      return;
    }
    // ⚠適用は**この結果の document をそのまま**履歴へ積む(通知の紐付け先と
    //   画面の document を同一参照にするため)。万一 dispatch 時点で document が
    //   進んでいたら(理論上の競合)、その場で再計算する=結果の整合を優先。
    setEditorState((prev) =>
      prev.document === captured
        ? { ...prev, document: r.document, dirty: true }
        : resolveOverlapsInState(prev),
    );
    const parts: string[] = [];
    if (r.shrunk.length > 0) parts.push(`縮小${r.shrunk.length}`);
    if (r.moved.length > 0) parts.push(`移動${r.moved.length}`);
    setAutoFix({
      doc: r.document,
      text:
        r.unresolved > 0
          ? `${parts.join("・")}で直しました。残り${r.unresolved}箇所は自動では直せません(ドラッグで調整してください)`
          : `${parts.join("・")}で直しました(「元に戻す」で戻せます)`,
    });
  }, [editorState.document]);

  return (
    <div className="flex flex-col h-full bg-neutral-200 dark:bg-zinc-900">
      {/* ── 物件への保存結果の知らせ(F3 Task6・一度だけ) ─────────────────── */}
      <WritebackNotice designId={initial.sheetId} />

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
        onAddMapQr={handleAddMapQr}
        canAddMapQr={canAddMapQr && isConsumer}
        mapQrDisabledReason={!isConsumer ? LEGACY_TEMPLATE_NOTE : undefined}
        canAutoLayout={isConsumer}
        onOpenTransactionInfo={() => setTxInfoOpen(true)}
        canEditTransactionInfo={isConsumer && editorState.document.elements.some((e) => e.id === "footer-band")}
        transactionInfoDisabledReason={!isConsumer ? LEGACY_TEMPLATE_NOTE : undefined}
        layoutWarning={layoutWarning}
        onAutoFixOverlaps={textTableOverlapCount > 0 ? handleAutoFixOverlaps : undefined}
        autoFixNotice={autoFixNotice}
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
              ref={canvasStageRef}
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
