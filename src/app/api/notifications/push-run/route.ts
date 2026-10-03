import { timingSafeEqual } from "crypto";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { runPushNotifications } from "@/lib/push/deliveries/run";
import { createWebPushSender, vapidConfig } from "@/lib/push/deliveries/web-push-sender";

/**
 * POST /api/notifications/push-run — 画面を閉じていても届く通知(Web プッシュ)の送信の実行口(timer 用)。
 * 通知 段階4b(設計書 §7.3)。
 *
 * 作りは巡回の自動終了(`/api/field-survey/sessions/auto-end-run`)と同型:
 * - `NOTIFICATIONS_PUSH_RUN_SECRET` 未設定なら **503(休眠=設定するまで何も送らない)**
 * - header `x-push-run-secret` 不一致は 403。人間の認証は不要(timer 駆動)
 * - VAPID の鍵3つがそろっていなければ 503(送らずに失敗で終わる=timer の失敗で気づける・§7.6)
 * - アプリのプロセスの中に常駐のタイマーは置かない(呼ばれたときだけ動く)
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスが必要(無いと 307)
 * - 応答は件数だけ(宛先・中身は出さない)
 */
export async function POST(request: Request) {
  try {
    const secret = process.env.NOTIFICATIONS_PUSH_RUN_SECRET;
    if (!secret) throw new ApiError(503, "通知の送信は未設定です", "NOT_CONFIGURED");
    const headerBuf = Buffer.from(request.headers.get("x-push-run-secret") ?? "");
    const secretBuf = Buffer.from(secret);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const vapid = vapidConfig();
    if (!vapid) throw new ApiError(503, "通知の鍵が未設定です", "PUSH_NOT_CONFIGURED");
    const result = await runPushNotifications(new Date(), createWebPushSender(vapid));
    return apiResponse(result);
  } catch (error) {
    return handleApiError(error);
  }
}
