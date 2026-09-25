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
 *   (review round2 Important A)。`fetchEditLockStatus` は `AbortSignal` を
 *   持たない素の `fetch` で、423 はもう保存が終わった後の応答なので、ここで
 *   何秒も待たせてよい理由が無い。上限を超えたら封筒の message にフォール
 *   バックする(`Promise.race`)。内部の問い合わせ自体は自前で catch して
 *   常に解決する(reject しない)ので、負けた側が後で reject しても
 *   unhandled rejection にはならない。
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
    const row = rows[0];
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
  const timeout = new Promise<string>((resolve) => {
    setTimeout(() => resolve(envelopeMessage), EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([lookup, timeout]);
}
