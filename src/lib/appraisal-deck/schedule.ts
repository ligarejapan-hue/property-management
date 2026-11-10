/**
 * 査定報告書を添付した応答のあとで、「査定のご報告」の下書きを作る(2026-11-10)。
 * ⚠添付の応答を待たせない・失敗しても添付は成立したまま(物件ページの「作り直す」で再挑戦できる)。
 * ⚠失敗の中身(数字・所在地・ファイルの場所)は出さない。
 */
import { after } from "next/server";
import { buildAppraisalDraft } from "./create-draft";

export function scheduleAppraisalDraft(input: { attachmentId: string; propertyId: string; userId: string }): void {
  const run = async () => {
    try {
      await buildAppraisalDraft(input);
    } catch {
      console.warn("[appraisal-deck] 下書きを作れませんでした", { attachmentId: input.attachmentId });
    }
  };
  try {
    after(run);
  } catch {
    // リクエストの外(テスト・スクリプト)では after が使えない=何もしない(添付は成立している)。
  }
}
