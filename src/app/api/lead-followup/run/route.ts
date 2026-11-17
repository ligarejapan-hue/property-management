import { timingSafeEqual } from "crypto";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { runLeadFollowups } from "@/lib/lead-followup/run";

/**
 * POST /api/lead-followup/run — 追客メールの送信の実行口(15分おきの timer 用・設計 2026-11-16 §8 PR3)。
 *
 * 作りは通知の送信(`/api/notifications/push-run`)と同型:
 * - `LEAD_FOLLOWUP_RUN_SECRET` 未設定なら **503(休眠=設定するまで何も送らない)**
 * - header `x-lead-followup-run-secret` 不一致は 403。人の認証は不要(timer 駆動)
 * - 追客メールが OFF なら、進行中を止めるだけで何も送らない(画面の ON/OFF が本当のスイッチ)
 * - アプリのプロセスの中に常駐のタイマーは置かない(呼ばれたときだけ動く)
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスが必要(無いと 307)。nginx で外からは 404
 * - 応答は件数だけ(宛先・件名・本文は出さない)
 */
/** 新しい送信・新しい行の判断を始めるのは、呼ばれてからこの時間まで(timer の curl は240秒・1通は最大およそ45秒)。 */
const RUN_DEADLINE_MS = 150_000;

export async function POST(request: Request) {
  try {
    const secret = process.env.LEAD_FOLLOWUP_RUN_SECRET;
    if (!secret) throw new ApiError(503, "追客メールの送信は未設定です", "NOT_CONFIGURED");
    const headerBuf = Buffer.from(request.headers.get("x-lead-followup-run-secret") ?? "");
    const secretBuf = Buffer.from(secret);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const summary = await runLeadFollowups(new Date(), { deadline: Date.now() + RUN_DEADLINE_MS });
    return apiResponse(summary);
  } catch (error) {
    return handleApiError(error);
  }
}
