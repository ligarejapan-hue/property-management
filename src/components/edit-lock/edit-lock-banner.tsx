"use client";

/**
 * 編集中の鍵の帯(仕様 6.2・6.3・6.4)。
 *
 * ⚠新しい色・形を作らない。`properties/[id]/page.tsx` の注意帯と同じ amber の組み。
 * ⚠文言は仕様の表のまま、1文字も変えない(発注者確定・N6で無期限の約束を外した版)。
 * ⚠判断はしない。渡された `EditLockUiState` / `EditLockStatusRow` をそのまま文字にするだけ
 *   (状態を決めるのは Task 2 の純関数と、呼び出し側の hook/一覧)。
 *
 * review round 1(task-4-review.md)の反映:
 * - Important #1: `createForceReleaseHandler`/`createConfirmReleaseHandler` への配線を
 *   source assertion で、通知の表示を render assertion で固定できるよう `initialNotice`/
 *   `initialNoticeRowKey`(テスト専用の初期値)を追加。
 * - Important #2: 衝突以外の失敗(`release()` の re-throw)を `createConfirmReleaseHandler`
 *   が捕まえ、汎用の失敗通知を出す。
 * - Important #3: 自分の別画面(`held_by_self_other_screen`)の確認文を氏名を使わない
 *   自然な文言に差し替え(`confirmReleaseMessage`)。
 * - Important #4(round1時点): 通知は「セットした時点の行(対象・状態)」に紐付け、新しい
 *   試行の開始時と行が変わったときに古い通知を出し続けない(`activeNotice`)。
 *
 * review round 2(task-4-review.md「## 再点検」)の反映:
 * - Important(round1の#4の続き・鍵が甘かった): `noticeRowKey` に `lockId` を含める。
 *   対象・状態が同じでも保持者(=`lockId`)が入れ替わっていれば別の行として扱い、
 *   古い通知(競合・失敗)を新しい保持者の行に持ち越さない。
 * - コントローラの裁定(round1の判断を反転): 通知は帯を**置き換えない**。通知が
 *   立っていても、いま held な行であれば保持者の文言と管理者の「鍵を外す」を**併記**する
 *   (round1では通知だけを出して帯を隠していたが、それだと衝突直後に管理者が
 *   今の鍵に対して何も操作できなくなるため)。
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorCode, forceReleaseEditLockApi, type EditLockStatusRow } from "@/lib/api-client";
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";

/**
 * ⚠export する(task5 review round1 Minor)。この帯が使われる画面はすべて、続く
 *   本文(エラー表示・最初のセクション等)との間に既存の `mb-4`(隣のエラー枠と同じ値)
 *   を空ける。呼び出し側(`property-edit-form.tsx`)が「鍵は取れなかったが保存は
 *   通常どおり行える」という**別の**通知を出すときも、同じ見た目を複製せずこれを使う。
 */
export const BAND =
  "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 mb-4";

/** 開始時刻は現地時間の HH:mm(仕様の見本と同じ)。解釈できない値は空文字(review Minor #1)。 */
export function formatSince(since?: string): string {
  if (!since) return "";
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return "";
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
 * ⚠競合以外の失敗は投げ直す(黙って握りつぶさない)。呼び出し側(`createConfirmReleaseHandler`)
 * がユーザーに見える通知に変える。
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
 * 確認ダイアログの本文(review Important #3)。他の人の編集は氏名入り(従来どおり)。
 * 自分の別画面(`held_by_self_other_screen`)には氏名が届かないため、氏名を使わない
 * 自然な文言にする(発注者裁定・そのまま1文字も変えない)。
 */
export function confirmReleaseMessage(row: Pick<EditLockStatusRow, "state" | "holderName">): string {
  if (row.state === "held_by_self_other_screen") {
    return "あなたの別の画面での編集を終わらせます。その画面で入力している内容は失われ、保存されません。その画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。";
  }
  const holderLabel = row.holderName ?? "この利用者";
  return `${holderLabel}さんの編集を終わらせます。${holderLabel}さんが今入力している内容は失われ、保存されません。${holderLabel}さんの画面は、この先5分間は保存できません(5分経つと、この記録はまた誰でも編集を始められる状態に戻ります)。`;
}

/**
 * 通知(状況が変わりました等)が、どの行(対象+状態+保持者)に対して出たものかの識別子。
 *
 * ⚠`lockId` を含める(review round2 Important)。対象+状態だけだと、同じ資源が同じ
 * `state`(例: `held_by_other`)へ**別の保持者**で戻ってきたときに、古い通知が
 * 新しい保持者の行にそのまま出てしまう(取得のたびに `lockId` は変わるため、
 * それを鍵に含めれば別の行として扱われる)。
 */
export function noticeRowKey(
  row: Pick<EditLockStatusRow, "resourceType" | "resourceId" | "state" | "lockId">,
): string {
  return `${row.resourceType}:${row.resourceId}:${row.state}:${row.lockId ?? ""}`;
}

/**
 * いま出してよい通知を決める純関数(review Important #4)。通知をセットした時点の
 * 行の識別子と、いま渡されている行の識別子が一致するときだけ出す。親が remount せずに
 * 別の行(対象・状態・保持者)を渡してきたら、古い「状況が変わりました」を出し続けない。
 */
export function activeNotice(
  notice: string | null,
  noticeForRowKey: string | null,
  row: Pick<EditLockStatusRow, "resourceType" | "resourceId" | "state" | "lockId">,
): string | null {
  if (notice === null || noticeForRowKey === null) return null;
  return noticeForRowKey === noticeRowKey(row) ? notice : null;
}

/**
 * 「鍵を外す」承諾ボタンの後始末(review Important #2・#4前半)。
 * - 新しい試行を始める前に、前回の通知を消す(#4前半: 新しい試行が始まったら古い通知を残さない)。
 * - `release()` が投げ直す「衝突以外の失敗」だけをここで捕まえ、ユーザーに見える通知にする(#2)。
 *   衝突(`EDIT_LOCK_CHANGED`)は `release()` の内側で既に通知をセットしていて投げ直さないので、
 *   ここでは何もしない。
 * - 成功・失敗どちらでもダイアログを閉じ、`busy` を戻す。
 */
export function createConfirmReleaseHandler({
  release,
  setBusy,
  setConfirmOpen,
  setNotice,
}: {
  release: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setConfirmOpen: (open: boolean) => void;
  setNotice: (message: string | null) => void;
}) {
  return async () => {
    setNotice(null);
    setBusy(true);
    try {
      await release();
    } catch {
      setNotice("編集を終了できませんでした。もう一度お試しください");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
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
  initialNotice = null,
  initialNoticeRowKey = null,
}: {
  row: EditLockStatusRow;
  isAdmin: boolean;
  onReleased: () => void;
  /**
   * テスト専用(review Important #1): 通知帯の初期値。node環境ではクリックを再現できず
   * `setNotice` を経由した通知の表示を確かめられないため、render assertion 用に公開する。
   */
  initialNotice?: string | null;
  /**
   * テスト専用(review Important #4): 上の通知が「どの行に対して出たものか」を明示する。
   * 省略時は今の `row` に対して出たものとみなす。
   */
  initialNoticeRowKey?: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNoticeState] = useState<string | null>(initialNotice);
  // ⚠ref ではなく state で持つ(react-hooks/refs: render中の ref 読み取りを禁止するルールを踏むため)。
  const [noticeRowKeyState, setNoticeRowKeyState] = useState<string | null>(
    initialNotice !== null ? (initialNoticeRowKey ?? noticeRowKey(row)) : null,
  );
  const setNotice = (message: string | null) => {
    setNoticeRowKeyState(message === null ? null : noticeRowKey(row));
    setNoticeState(message);
  };

  const shownNotice = activeNotice(notice, noticeRowKeyState, row);
  const isHeld = row.state === "held_by_other" || row.state === "held_by_self_other_screen";
  // ⚠通知は帯を置き換えない(review round2・コントローラの裁定でround1の判断を反転)。
  //   通知が立っていても、いま held な行なら保持者の文言+管理者のボタンを併記する。
  //   さもないと、衝突直後に管理者が「今まさにある鍵」に対して何も操作できなくなる。
  if (!shownNotice && !isHeld) return null;

  const label =
    row.state === "held_by_self_other_screen"
      ? `🔒 あなたが別の画面で編集中です(${formatSince(row.since)}〜)`
      : `🔒 ${row.holderName}さんが編集中です(${formatSince(row.since)}〜)`;

  const release = createForceReleaseHandler({ row, onReleased, setNotice });
  const confirmRelease = createConfirmReleaseHandler({ release, setBusy, setConfirmOpen, setNotice });

  return (
    <div className={BAND}>
      <div className="flex flex-1 flex-col gap-1">
        {shownNotice && <span>{shownNotice}</span>}
        {isHeld && <span>{label}</span>}
      </div>
      {isHeld && isAdmin && row.lockId && (
        <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          鍵を外す
        </Button>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title="編集の鍵を外しますか"
          message={confirmReleaseMessage(row)}
          confirmLabel="編集を終わらせる"
          busy={busy}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={confirmRelease}
        />
      )}
    </div>
  );
}
