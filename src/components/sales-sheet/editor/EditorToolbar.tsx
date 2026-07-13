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
  /** 会社帯の物件別6項目(取引情報)の編集モーダルを開く。 */
  onOpenTransactionInfo: () => void;
}

export function EditorToolbar({ dirty, onSave, onExport, onDelete, onAddPhoto, onAutoArrange, onAutoBalance, onAddBadge, onAddQr, onOpenTransactionInfo }: EditorToolbarProps) {
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
      className="flex items-center gap-2 px-4 py-2 border-b border-neutral-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 shrink-0"
    >
      {dirty && (
        <span
          data-dirty-indicator
          className="text-xs text-amber-600 dark:text-amber-400"
        >
          未保存の変更があります
        </span>
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
        className="rounded px-3 py-1.5 text-sm border border-neutral-300 dark:border-zinc-600 hover:bg-neutral-100 dark:hover:bg-zinc-700 disabled:opacity-50 dark:text-neutral-200"
      >
        写真を自動整列
      </button>
      <button
        type="button"
        data-toolbar-auto-balance
        onClick={onAutoBalance}
        disabled={busy}
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
        data-toolbar-transaction-info
        onClick={onOpenTransactionInfo}
        disabled={busy}
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
  );
}
