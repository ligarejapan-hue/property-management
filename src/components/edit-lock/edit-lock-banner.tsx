"use client";

/**
 * 編集中の鍵の帯(仕様 6.2・6.3・6.4)。
 *
 * ⚠新しい色・形を作らない。`properties/[id]/page.tsx` の注意帯と同じ amber の組み。
 * ⚠文言は仕様の表のまま、1文字も変えない(発注者確定・N6で無期限の約束を外した版)。
 * ⚠判断はしない。渡された `EditLockUiState` / `EditLockStatusRow` をそのまま文字にするだけ
 *   (状態を決めるのは Task 2 の純関数と、呼び出し側の hook/一覧)。
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorCode, forceReleaseEditLockApi, type EditLockStatusRow } from "@/lib/api-client";
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";

const BAND =
  "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";

/** 開始時刻は現地時間の HH:mm(仕様の見本と同じ)。 */
export function formatSince(since?: string): string {
  if (!since) return "";
  const d = new Date(since);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * いま画面を見ている本人向けの帯(自分が鍵を持っている/持っていない画面の両方で使う)。
 * `mine` は編集できている=既定では何も出さない(55分の予告があるときだけ出す)。
 */
export function EditLockBanner({ state, warnIdle }: { state: EditLockUiState; warnIdle: boolean }) {
  if (state.kind === "mine") {
    return warnIdle ? <div className={BAND}>操作がないため、あと5分で編集を終了します</div> : null;
  }
  if (state.kind === "idle") return null;
  if (state.kind === "expired") {
    return (
      <div className={BAND}>
        しばらく画面が止まっていたため、編集の鍵が外れました。入力すると自動で取り直します
      </div>
    );
  }
  if (state.kind === "force_released") {
    return <div className={BAND}>管理者が編集を終了しました。この内容は保存できません</div>;
  }
  if (state.kind === "deleted") {
    return <div className={BAND}>この記録は削除されたため、編集を続けられません</div>;
  }
  return <div className={BAND}>{`🔒 ${state.holderName}さんが編集中です(${formatSince(state.since)}〜)`}</div>;
}

/**
 * 「鍵を外す」を押したときの動きだけを切り出したもの(node で直接検査するため・部品からは
 * 見た目を除いた純粋な非同期処理)。
 *
 * ⚠成功・`EDIT_LOCK_CHANGED`(競合)の**どちらの経路でも** `onReleased()` を呼ぶ。競合は
 * 「自分が呼ぶより前に誰かが鍵を変えた」という意味であり、手元の表示は既に古いので、
 * 作り直すのが正しい(成功したときと同じ後始末)。
 */
export function createForceReleaseHandler({
  row,
  onReleased,
  setNotice,
}: {
  row: EditLockStatusRow;
  onReleased: () => void;
  setNotice: (message: string) => void;
}) {
  return async () => {
    if (!row.lockId) return;
    try {
      await forceReleaseEditLockApi(row.resourceType, row.resourceId, row.lockId);
      onReleased();
    } catch (e) {
      if (apiErrorCode(e) === "EDIT_LOCK_CHANGED") {
        setNotice("状況が変わりました。表示を更新します");
        onReleased();
        return;
      }
      throw e;
    }
  };
}

/**
 * 一覧・カードなど、資源を開かずに状態だけ見ている画面向けの帯。
 * 管理者にだけ「鍵を外す」を出す(`lockId` は窓口が管理者にしか返さないため、
 * それ自体が権限の境界になっている)。
 */
export function EditLockHolderBanner({
  row,
  isAdmin,
  onReleased,
}: {
  row: EditLockStatusRow;
  isAdmin: boolean;
  onReleased: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (notice) return <div className={BAND}>{notice}</div>;
  if (row.state !== "held_by_other" && row.state !== "held_by_self_other_screen") return null;

  const label =
    row.state === "held_by_self_other_screen"
      ? `🔒 あなたが別の画面で編集中です(${formatSince(row.since)}〜)`
      : `🔒 ${row.holderName}さんが編集中です(${formatSince(row.since)}〜)`;
  const holderLabel = row.holderName ?? "この利用者";

  const release = createForceReleaseHandler({ row, onReleased, setNotice });

  return (
    <div className={BAND}>
      <span className="flex-1">{label}</span>
      {isAdmin && row.lockId && (
        <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          鍵を外す
        </Button>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title="編集の鍵を外しますか"
          message={`${holderLabel}さんの編集を終わらせます。${holderLabel}さんが今入力している内容は失われ、保存されません。${holderLabel}さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。`}
          confirmLabel="編集を終わらせる"
          busy={busy}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await release();
            } finally {
              setBusy(false);
              setConfirmOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}
