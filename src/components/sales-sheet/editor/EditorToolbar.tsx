"use client";

import { useState } from "react";

export interface EditorToolbarProps {
  dirty: boolean;
  onSave: () => Promise<void>;
  onExport: (format: "pdf" | "png") => Promise<void>;
  onDelete: () => Promise<void>;
  onAddPhoto: () => void;
  /** 写真（image 要素）を写真ゾーンへワンボタン整列（計画⑥）。 */
  onAutoArrange: () => void;
  /** テンプレ全体を内容に合わせてワンボタン再バランス（機能A）。 */
  onAutoBalance: () => void;
  /** オリジナルバッジ要素を追加（バッジデザイナー・計画⑦）。 */
  onAddBadge: () => void;
  /** QR コード要素を追加（計画⑧）。 */
  onAddQr: () => void;
  /** 物件の場所を Google マップ検索する QR を間取図の下(無ければ右下)へ追加。 */
  onAddMapQr?: () => void;
  /** 物件の住所が登録されているか。false のとき地図QRボタンを無効化。 */
  canAddMapQr?: boolean;
  /** 会社帯の物件別6項目(取引情報)の編集モーダルを開く。 */
  onOpenTransactionInfo: () => void;
  /** 会社帯(footer-band)を持つ図面か。古い様式で作成され帯が無い図面では
   *  「取引情報」を編集しても反映先が無いため、ボタンを無効化して黙って捨てるのを防ぐ。
   *  未指定は true(帯ありとして扱う)。 */
  canEditTransactionInfo?: boolean;
  /** 元に戻す(Ctrl+Z)。canUndo=false のとき非活性。未指定はボタン非表示(後方互換)。 */
  onUndo?: () => void;
  canUndo?: boolean;
  /** やり直す(Ctrl+Y)。canRedo=false のとき非活性。未指定はボタン非表示(後方互換)。 */
  onRedo?: () => void;
  canRedo?: boolean;
  /** B-8: 文字・表どうしの重なり検知の注意文言(重なりなし/未指定は非表示)。
   *  自動整列・自動調整は文字を動かさない仕様のため、出力前に気付けるように出す。 */
  layoutWarning?: string | null;
  /** B-8 案A: 「重なりを自動で直す」(押したときだけ動かす)。 */
  onAutoFixOverlaps?: () => void;
  /** B-8 案A: 自動修正の結果メッセージ(なければ非表示)。 */
  autoFixNotice?: string | null;
}

export function EditorToolbar({ dirty, onSave, onExport, onDelete, onAddPhoto, onAutoArrange, onAutoBalance, onAddBadge, onAddQr, onAddMapQr, canAddMapQr = false, onOpenTransactionInfo, canEditTransactionInfo = true, onUndo, canUndo = false, onRedo, canRedo = false, layoutWarning = null, onAutoFixOverlaps, autoFixNotice = null }: EditorToolbarProps) {
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function handleExport(format: "pdf" | "png") {
    setExporting(true);
    setError(null);
    try {
      await onExport(format);
    } catch (e) {
      setError(e instanceof Error ? e.message : "出力に失敗しました");
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    if (!confirm("この販売図面を削除しますか？")) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  }

  const busy = saving || exporting || deleting;

  return (
    <div
      data-editor-toolbar
      className="border-b border-neutral-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 shrink-0"
    >
    <div className="flex items-center gap-2 px-4 py-2">
      {dirty && (
        <span
          data-dirty-indicator
          className="text-xs text-amber-600 dark:text-amber-400"
        >
          未保存の変更があります
        </span>
      )}
      {onUndo && (
        <button
          type="button"
          data-toolbar-undo
          onClick={onUndo}
          disabled={busy || !canUndo}
          title="元に戻す (Ctrl+Z)"
          className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
        >
          ← 元に戻す
        </button>
      )}
      {onRedo && (
        <button
          type="button"
          data-toolbar-redo
          onClick={onRedo}
          disabled={busy || !canRedo}
          title="やり直す (Ctrl+Y)"
          className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
        >
          やり直す →
        </button>
      )}
      <button
        type="button"
        data-toolbar-save
        onClick={handleSave}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {saving ? "保存中…" : "保存"}
      </button>
      <button
        type="button"
        data-toolbar-add-photo
        onClick={onAddPhoto}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        写真を追加
      </button>
      <button
        type="button"
        data-toolbar-auto-arrange
        onClick={onAutoArrange}
        disabled={busy}
        title="写真がある場合に、写真の並びと概要表の位置を整えます。文字・バッジ・QR・概要表以外の表は動きません"
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        写真を自動整列
      </button>
      <button
        type="button"
        data-toolbar-auto-balance
        onClick={onAutoBalance}
        disabled={busy}
        title="見出し・価格・キャッチコピー・概要表・間取図・写真・地図QRなどの定型項目を標準の配置に戻します(手で動かしていても戻ります)。自分で追加した文字・バッジ・QR(地図QRを除く)は動きません"
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        レイアウト自動調整
      </button>
      <button
        type="button"
        data-toolbar-add-badge
        onClick={onAddBadge}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        バッジを追加
      </button>
      <button
        type="button"
        data-toolbar-add-qr
        onClick={onAddQr}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        QRを追加
      </button>
      <button
        type="button"
        data-toolbar-add-map-qr
        onClick={onAddMapQr}
        disabled={busy || !canAddMapQr}
        title={!canAddMapQr ? "物件の住所が未登録です" : "物件の場所（Googleマップ）のQRを間取図の下に追加"}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        地図QRを追加
      </button>
      <button
        type="button"
        data-toolbar-transaction-info
        onClick={onOpenTransactionInfo}
        disabled={busy || !canEditTransactionInfo}
        title={!canEditTransactionInfo ? "この図面には会社帯がありません（古い様式で作成された図面）" : undefined}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        取引情報
      </button>
      <button
        type="button"
        data-toolbar-export="pdf"
        onClick={() => handleExport("pdf")}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        {exporting ? "出力中…" : "PDF出力"}
      </button>
      <button
        type="button"
        data-toolbar-export="png"
        onClick={() => handleExport("png")}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        PNG出力
      </button>
      <div className="flex-1" />
      {error && (
        <span
          data-toolbar-error
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </span>
      )}
      <button
        type="button"
        data-toolbar-delete
        onClick={handleDelete}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm text-red-600 border border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/20 disabled:opacity-50"
      >
        {deleting ? "削除中…" : "削除"}
      </button>
    </div>
    {/* B-8: 文字・表の重なり注意はボタン行と競合しない独立行に全文表示する
        (@codex #310 R4/R6: flex 行内だと幅次第で折返し崩れ or 0 幅で消える)。
        エラー表示とは独立に出す (@codex R12: 保存/出力失敗の error が残っている
        間も、その後のレイアウト編集で必要な警告を消さない)。 */}
    {layoutWarning && (
      <p
        data-toolbar-layout-warning
        className="px-4 pb-1.5 text-sm text-amber-700 dark:text-amber-400"
      >
        {layoutWarning}
        {/* B-8 案A: 押したときだけ自動で直す(勝手には動かさない)。 */}
        {onAutoFixOverlaps && (
          <button
            type="button"
            onClick={onAutoFixOverlaps}
            disabled={busy}
            data-toolbar-auto-fix-overlaps
            className="ml-2 rounded border border-amber-400 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-600 dark:bg-gray-800 dark:text-amber-300 dark:hover:bg-amber-900/40"
          >
            重なりを自動で直す
          </button>
        )}
      </p>
    )}
    {/* 自動修正の結果。⚠重なりが全部消えると layoutWarning ごと消えるため、
        「直りました」はこの独立行が伝える(黙って消えると押した人が結果を知れない)。 */}
    {autoFixNotice && (
      <p
        data-toolbar-auto-fix-notice
        className="px-4 pb-1.5 text-sm text-emerald-700 dark:text-emerald-400"
      >
        {autoFixNotice}
      </p>
    )}
    </div>
  );
}
