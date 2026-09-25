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

/**
 * 保存ボタンを押せるか(task5 review round1 Important #3)。
 * ⚠この判断自体をテストで直接検査できるよう、JSX の `disabled={}` から切り出す
 *   (`disabled={` という文字列は画面に複数箇所あり、走査だけでは
 *   「決定が実行されているか」を固定できないため)。
 * `lockUnavailable` が true のときは `canSave` が false でも押せる(fail open)。
 */
export function canSubmitSave({
  tokenReady,
  canSave,
  saving,
  lockUnavailable,
}: {
  tokenReady: boolean;
  canSave: boolean;
  saving: boolean;
  lockUnavailable: boolean;
}): boolean {
  if (!tokenReady || saving) return false;
  return canSave || lockUnavailable;
}

/**
 * fail openの通知(「編集中の表示を取得できませんでした。保存は通常どおり行えます」)を
 * 出してよいか(task5 review round2 N3)。
 * ⚠**`idle` の間だけ**。取得が失敗した後、保存が423等で断られて `lock.state` が
 *   `idle` 以外(`taken`/`expired`/`force_released`/`deleted`)へ動いたら、実際の
 *   鍵の帯(`EditLockBanner`)が表示を引き継ぐ。両方を同時に出すと、「保存は通常
 *   どおり行えます」と実際の鍵の帯(保存できない旨)が矛盾したまま、利用者が
 *   繰り返し423を踏むことになる。
 */
export function shouldShowLockUnavailableNotice(
  lockUnavailable: boolean,
  stateKind: EditLockUiState["kind"],
): boolean {
  return lockUnavailable && stateKind === "idle";
}
