/**
 * 査定報告書を添付した応答のあとで、「査定のご報告」の下書きを作る(2026-11-10)。
 * ⚠添付の応答を待たせない・失敗しても添付は成立したまま(物件ページの「作り直す」で再挑戦できる)。
 * ⚠失敗の中身(数字・所在地・ファイルの場所)は出さない。
 */
import { after } from "next/server";
import { buildAppraisalDraft } from "./create-draft";

/** 読み取りが混んでいた(busy)ときに待ってやり直す回数と間隔。 */
export const BUSY_RETRIES = 3;
export const BUSY_WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function scheduleAppraisalDraft(input: { attachmentId: string; propertyId: string; userId: string }): void {
  const run = async () => {
    try {
      for (let i = 0; i <= BUSY_RETRIES; i++) {
        const r = await buildAppraisalDraft(input);
        if (r.ok || r.reason !== "busy" || i === BUSY_RETRIES) return;
        await sleep(BUSY_WAIT_MS);
      }
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
