/**
 * 編集中の鍵(仕様 6.2)まわりの、保存の可否を決める純関数(決定層)。
 *
 * ⚠Task 5(`src/components/properties/property-edit-form.tsx`)が最初に切り出した
 *   判断で、Task 6(所有者カード・`src/app/(dashboard)/properties/[id]/page.tsx`)が
 *   そのまま再利用している。以前は `property-edit-form.tsx` に置かれ、そこから
 *   `page.tsx` が直接 import していたが、鍵を使う3つめの画面が増えたときに
 *   `"use client"` のコンポーネントモジュール一式(lucide-react・住所補完・
 *   物件フォーム全体)を巻き込んで import することになるため、判断層専用の
 *   `src/lib/edit-lock/`(`ui-state.ts`・`rules.ts`・`controller.ts` と同じ並び)へ
 *   移した(branch review・Task 6 fix round 1 #3)。
 *
 * 呼び出し側(画面)は必ずこのファイルから import する。コピー&ペーストで
 * 複製しない(判断がずれると、鍵の取得に失敗しても保存ボタンが永久に押せなくなる
 * Critical=Task5 round1 の再発になる)。
 */
import type { EditLockUiState } from "./ui-state";
import type { EditLockStatusRow } from "@/lib/api-client";

/**
 * fail open の旗(`lockUnavailable`)が**今も効いているか**(横断レビュー I1)。
 *
 * この旗の意味は「鍵の取得自体が失敗した=鍵を**見られない**」でしかなく、
 * 「鍵が無い」ではない。サーバが権威なので、見られないことを理由に画面が保存を
 * 止めてはいけない(fail open・task5 review round1 Critical)。
 * ⚠だが**`idle` の間だけ**。取得が失敗した後に保存が423で断られて状態が
 *   `taken`/`expired`/`force_released`/`deleted` へ動いたら、鍵の実情は
 *   もう「見られない」ではなく「見えていて、保存できない」。そこでこの旗を
 *   効かせ続けると、帯が「この内容は保存できません」と出しているのに
 *   保存ボタンだけ押せる自己矛盾になる(`lockUnavailable` は閉じる/キャンセル/
 *   保存成功でしか戻らないため、一度立つと状態が動いても永久に true)。
 * ⚠**帯の通知とボタンはこの1本の判定を共有する**。同じ条件を2か所に書くと、
 *   片方だけ直した過去(通知は状態を見るのにボタンは見ていなかった=I1)を
 *   繰り返す。
 */
function isLockUnavailableFailOpen(
  lockUnavailable: boolean,
  stateKind: EditLockUiState["kind"],
): boolean {
  return lockUnavailable && stateKind === "idle";
}

/**
 * 保存ボタンを押せるか(task5 review round1 Important #3)。
 * ⚠この判断自体をテストで直接検査できるよう、JSX の `disabled={}` から切り出す
 *   (`disabled={` という文字列は画面に複数箇所あり、走査だけでは
 *   「決定が実行されているか」を固定できないため)。
 * `lockUnavailable` が true でも押せるのは、鍵の状態が `idle` の間だけ
 * (= fail open が効いている間だけ・横断レビュー I1。`stateKind` は必須にして、
 * 呼び出し側が状態を渡し忘れられないようにする)。
 */
export function canSubmitSave({
  tokenReady,
  canSave,
  saving,
  lockUnavailable,
  stateKind,
}: {
  tokenReady: boolean;
  canSave: boolean;
  saving: boolean;
  lockUnavailable: boolean;
  stateKind: EditLockUiState["kind"];
}): boolean {
  if (!tokenReady || saving) return false;
  return canSave || isLockUnavailableFailOpen(lockUnavailable, stateKind);
}

/**
 * fail openの通知(「編集中の表示を取得できませんでした。保存は通常どおり行えます」)を
 * 出してよいか(task5 review round2 N3)。
 * ⚠**`idle` の間だけ**。取得が失敗した後、保存が423等で断られて `lock.state` が
 *   `idle` 以外(`taken`/`expired`/`force_released`/`deleted`)へ動いたら、実際の
 *   鍵の帯(`EditLockBanner`)が表示を引き継ぐ。両方を同時に出すと、「保存は通常
 *   どおり行えます」と実際の鍵の帯(保存できない旨)が矛盾したまま、利用者が
 *   繰り返し423を踏むことになる。
 * ⚠判定そのものは `canSubmitSave` と**同じ1本**(`isLockUnavailableFailOpen`)。
 */
export function shouldShowLockUnavailableNotice(
  lockUnavailable: boolean,
  stateKind: EditLockUiState["kind"],
): boolean {
  return isLockUnavailableFailOpen(lockUnavailable, stateKind);
}

/**
 * 見ている側(仕様 6.3・Task 9)。`useEditLockStatus` から届く1件の行が、
 * 「他の人(または自分の別画面)が持っている」= 操作を止める対象かどうか。
 * ⚠`held_by_self_other_screen` も止める(D6=同じ利用者でも別画面の編集とは
 *   衝突させない・帯の文言も6.3の表のとおり「あなたが別の画面で編集中です」)。
 *   `mine`・`free`・行が届いていない(未取得・権限なし)は止めない(fail open)。
 */
export function isEditLockHeldByOther(row: EditLockStatusRow | undefined): boolean {
  return row?.state === "held_by_other" || row?.state === "held_by_self_other_screen";
}

/**
 * 見ている側(仕様 6.3・Task 9 fix round1 Important 5)。無効化した編集ボタンに
 * 添える理由の `title`。**状態で出し分ける**——`held_by_self_other_screen` は
 * 自分自身の別画面での編集なので、帯の「あなたが別の画面で編集中です」と
 * 矛盾しない主語にする(修理前は両方の held 状態で「他の利用者が…」に固定
 * されており、タブを複製しただけの利用者に「他の人が編集中」と誤って伝えていた)。
 * ⚠呼び出し側は `isEditLockHeldByOther(row)` が true のときだけこれを使う想定
 *   (それ以外の状態でも呼べるように総ての分岐を持つが、free/mine/undefinedの
 *   ときの戻り値は「使われない」前提の既定値でしかない)。
 */
export function editLockUnavailableTitle(row: EditLockStatusRow | undefined): string {
  return row?.state === "held_by_self_other_screen"
    ? "あなたが別の画面で編集中のため編集できません"
    : "他の利用者が編集中のため編集できません";
}
