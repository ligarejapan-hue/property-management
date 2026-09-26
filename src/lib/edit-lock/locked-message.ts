/**
 * 鍵を持たない入口が 423 `EDIT_LOCKED` を受けたときの文言を組み立てる
 * (仕様 6.5・fix round 1〜2)。
 *
 * ⚠窓口(`assertNotEditLockedByOther`・`src/lib/edit-lock/service.ts`)の423は
 *   保持者名も開始時刻も返さない(「他の画面で編集中です」だけ)。そのデータは
 *   状態の窓口(`fetchEditLockStatus`)にしかないため、`EDIT_LOCKED` を受けた
 *   **そのときだけ**その資源1件を状態窓口へ問い合わせ、帯(`EditLockBanner`)と
 *   同じ文言(「{氏名}さんが編集中です({HH:mm}〜)」・`formatSince` を再利用)を
 *   組み立てる。まれな経路の1回きりの追加リクエストであり、先読み・ポーリングは
 *   しない。
 * ⚠問い合わせが失敗した・該当行が無い・「他の人が持っている」以外(自分の別画面
 *   ・free 等)なら、呼び出し側が渡した封筒の `message` にフォールバックする。
 *   どの分岐でも画面を無言のままにしない(仕様 6.5)。
 * ⚠**このモジュールは `src/lib/` に置く純関数/非同期関数だけの集まりで、
 *   component モジュール("use client" な `.tsx`)を import しない**(review round2
 *   Important B)。`formatSince` は `edit-lock-banner.tsx`(`ui/button`・
 *   `ui/confirm-dialog`・`api-client` を引き込む)ではなく、それらを持たない
 *   `ui-state.ts` から取る。Task 6 fix round 1 #3 が `canSubmitSave`/
 *   `shouldShowLockUnavailableNotice` を同じ理由でコンポーネントモジュールの
 *   外へ出した判断と揃える(そちらを踏襲せず一度違反していたのを、この回で直す)。
 * ⚠**問い合わせには上限時間(`EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS`)を設ける**
 *   (review round2 Important A・round3 Minor H)。上限を超えたら封筒の message
 *   にフォールバックする(`Promise.race`)。⚠この上限は「控え(ボタン等)を
 *   塞がないため」ではない(round2時点の誤り。round3で訂正=呼び出し側が
 *   もう `await` しないため、控えは既に即座に解放されている)。役目は
 *   ①`setTimeout` をいつまでも宙に浮かせないこと、②Important G の世代の
 *   見張り(`prev === envelopeMessage`)が効く現実的な時間内に組み立てを
 *   届かせること、の2つだけ。内部の問い合わせ自体は自前で catch して
 *   常に解決する(reject しない)ので、負けた側が後で reject しても
 *   unhandled rejection にはならない。
 * ⚠**負けた側のタイマーは片付ける**(review round3 Minor I)。`Promise.race` で
 *   タイムアウト側が勝っても・負けても、`setTimeout` のハンドルは
 *   `clearTimeout` する(勝った側=問い合わせが先に終わったときに、タイマーだけ
 *   宙に浮いたまま残らないようにする)。
 * ⚠**呼び出し元が持っている状態行は再利用しない(Task 9で試み、review round2
 *   N2で撤去)**。物件詳細(見ている側)は `useEditLockStatus` で30秒ごとに
 *   状態を持っているため、案件ステータス・導入ルートのプルダウンが保存直後に
 *   受け取る423のときも「その行を渡せば問い合わせを省けるのでは」と考えたが、
 *   **その行はこの入口の保存ボタン自体を無効化している行と同じ**
 *   (`page.tsx` の `disabled={... || editLockHeld}`)。保存が実際に実行できて
 *   423を受け取れる時点では、ボタンが無効化されていない=その行は
 *   `held_by_other`(氏名を名乗れる状態)では**あり得ない**(直前の30秒
 *   ポーリングと今の423の間に、たった今誰かが鍵を取った場合に限られる)。
 *   つまり再利用が効く条件と、この関数が呼ばれる条件は構造的に両立しない
 *   ——「使えるときは呼ばれず、呼ばれるときは使えない」死んだ最適化だった
 *   (round1 Important 2 で「氏名を名乗るときだけ使う」封じ込みを入れたが、
 *   それでも到達しない分岐が残ることに変わりはなく、round2で除去した)。
 *   1回きりの追加リクエストのまま素直に問い合わせる。
 */
import { fetchEditLockStatus, type EditLockStatusRow } from "@/lib/api-client";
import { formatSince } from "@/lib/edit-lock/ui-state";
import { EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS } from "@/lib/edit-lock/rules";

async function lookupComposedMessage(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
  envelopeMessage: string,
): Promise<string> {
  try {
    const rows = await fetchEditLockStatus([{ resourceType, resourceId }]);
    const row = rows.find((r) => r.resourceType === resourceType && r.resourceId === resourceId);
    if (row && row.state === "held_by_other" && row.holderName) {
      return `${row.holderName}さんが編集中です(${formatSince(row.since)}〜)`;
    }
  } catch {
    // 問い合わせの失敗は無視してフォールバックへ落ちる(下の return)。
  }
  return envelopeMessage;
}

export async function composeEditLockedMessage(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
  envelopeMessage: string,
): Promise<string> {
  const lookup = lookupComposedMessage(resourceType, resourceId, envelopeMessage);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(envelopeMessage), EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    // ⚠review round3 Minor I: 問い合わせが先に終わって timeout 側が負けても、
    //   宙に浮いた setTimeout をここで必ず片付ける。
    clearTimeout(timer);
  }
}
