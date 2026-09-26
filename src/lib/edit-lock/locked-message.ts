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

/**
 * 状態窓口が名乗れた保持者(仕上げround2の裁定)。
 * ⚠**文言だけでなくこの生の値を呼び出し側へ渡す**。エラー表示(6.5の氏名+時刻)と
 *   帯(6.2の一文・実名)が同じ1回の問い合わせ結果を共有するため=帯のためだけに
 *   2回目を引かない。
 */
export type EditLockHolder = { holderName: string; since?: string };

/**
 * 状態窓口を**1回だけ**引いて、「他の人が持っている」行の氏名+開始時刻を返す。
 * 名乗れない(問い合わせ失敗・該当行なし・free/mine/自分の別画面)なら `null`。
 * ⚠`reject` しない(失敗は `null` に畳む)。呼び出し側の `Promise.race` の
 *   負けた側が後で reject して unhandled rejection になるのを避ける。
 */
async function lookupEditLockHolder(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
): Promise<EditLockHolder | null> {
  try {
    const rows = await fetchEditLockStatus([{ resourceType, resourceId }]);
    const row = rows.find((r) => r.resourceType === resourceType && r.resourceId === resourceId);
    if (row && row.state === "held_by_other" && row.holderName) {
      return { holderName: row.holderName, since: row.since };
    }
  } catch {
    // 問い合わせの失敗は無視してフォールバック(null)へ落ちる。
  }
  return null;
}

/** 仕様6.5の文言。名乗れなければ封筒の `message` へフォールバックする。 */
function messageFromHolder(holder: EditLockHolder | null, envelopeMessage: string): string {
  return holder ? `${holder.holderName}さんが編集中です(${formatSince(holder.since)}〜)` : envelopeMessage;
}

/**
 * 上限時間つきで保持者を1回引く(`EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS`)。
 * 上限を超えたら `null`(=名乗れなかった)として扱う。
 * ⚠**負けた側のタイマーは片付ける**(review round3 Minor I)。
 */
async function lookupHolderWithTimeout(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
): Promise<EditLockHolder | null> {
  const lookup = lookupEditLockHolder(resourceType, resourceId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `useState` の更新関数と同じ形(`Dispatch<SetStateAction<string | null>>`)。
 * ⚠react を import しないで書ける最小の形にする(このモジュールは純関数/非同期
 *   関数だけの集まりで、component も react も引かない)。
 */
export type EditLockedMessageSetter = (
  next: string | null | ((prev: string | null) => string | null),
) => void;

/**
 * 鍵を**持つ**入口(編集ウィンドウ・所有者カード)が保存で 423 `EDIT_LOCKED` を
 * 受けたときのエラー表示(横断レビュー I2)。
 *
 * ⚠修理前、この2画面は封筒の `message`(段階1のサーバは「他の画面で編集中です」しか
 *   返さない)をそのまま出すだけで、**氏名も時刻も出なかった**。鍵を持たない3入口は
 *   `composeEditLockedMessage` で状態窓口を1回引いて実名+時刻を出しており、
 *   「最も名前が要る2画面が、最も要らない3入口より情報が少ない」状態だった。
 *   同じ helper をこちらでも通す(組み立ての規則を2つ持たない)。
 * ⚠`await` しない(round2 Important A): 封筒の message を**同期的に即座に**出し、
 *   組み立ては届いてから差し替える。控え(保存ボタンの `saving`)を待たせない。
 * ⚠差し替えは世代の見張りつき(round3 Important G): いま出ている値がその試行の
 *   封筒の message のままのときだけ差し替える。保存が成功して表示が消えていたり、
 *   別の試行の message に変わっていれば何もしない。
 */
export function showComposedEditLockedMessage(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
  envelopeMessage: string,
  setError: EditLockedMessageSetter,
  onHolderIdentified: (holder: EditLockHolder) => void,
): void {
  setError(envelopeMessage);
  void lookupHolderWithTimeout(resourceType, resourceId).then((holder) => {
    // ⚠(仕上げround2) **帯が先**。同じ1回の問い合わせ結果で、帯の氏名も直す
    //   (帯が「他の利用者さん」と言ったまま、すぐ下のエラー表示が実名を名乗る
    //   食い違いを出さない=この機能の存在理由である「誰が編集しているか」に
    //   画面が2つの違う答えを出さない)。名乗れなければ呼ばない=帯は既定の文言のまま。
    if (holder) onHolderIdentified(holder);
    const composed = messageFromHolder(holder, envelopeMessage);
    setError((prev) => (prev === envelopeMessage ? composed : prev));
  });
}

/**
 * 鍵を**持たない**3入口(案件ステータス・導入ルートのプルダウン・地番ポップアップ)用。
 * 文言だけを返す(帯を持たない入口なので保持者そのものは要らない)。
 * ⚠`showComposedEditLockedMessage` と**同じ1本の問い合わせ**(`lookupHolderWithTimeout`)を
 *   使う=組み立ての規則も上限時間も2つに分かれない。
 */
export async function composeEditLockedMessage(
  resourceType: EditLockStatusRow["resourceType"],
  resourceId: string,
  envelopeMessage: string,
): Promise<string> {
  return messageFromHolder(await lookupHolderWithTimeout(resourceType, resourceId), envelopeMessage);
}
