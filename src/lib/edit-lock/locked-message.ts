/**
 * 鍵を持たない入口が 423 `EDIT_LOCKED` を受けたときの文言を組み立てる
 * (仕様 6.5・fix round 1)。
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
 */
import { fetchEditLockStatus, type EditLockStatusRow } from "@/lib/api-client";
import { formatSince } from "@/components/edit-lock/edit-lock-banner";

export async function composeEditLockedMessage(
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
