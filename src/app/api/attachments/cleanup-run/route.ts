import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { purgeExpiredAttachments } from "@/lib/attachment-cleanup";

/**
 * POST /api/attachments/cleanup-run — 添付お掃除の実行口（cron 用）。
 * - `ATTACHMENT_CLEANUP_SECRET` 未設定なら 503（dormant＝本番は設定するまで何も消えない）。
 * - header `x-cleanup-secret` が一致しなければ 403。人間 auth は不要（cron 駆動）。
 * - `?dryRun=1` で件数のみ（削除しない）。バッチ上限 200/回。
 * - DB 監査は持たず（人間 actor 無し）journald(console) と返却値で記録。
 */
const BATCH_LIMIT = 200;

export async function POST(request: Request) {
  try {
    const secret = process.env.ATTACHMENT_CLEANUP_SECRET;
    if (!secret) {
      throw new ApiError(503, "添付お掃除は未設定です", "NOT_CONFIGURED");
    }
    if (request.headers.get("x-cleanup-secret") !== secret) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const result = await purgeExpiredAttachments({ now: new Date(), limit: BATCH_LIMIT, dryRun });
    // 非PII の運用ログ（件数のみ）。journald に残す。
    console.log(`[attachment-cleanup] scanned=${result.scanned} purged=${result.purged} dryRun=${dryRun}`);
    return apiResponse({ ...result, dryRun });
  } catch (error) {
    return handleApiError(error);
  }
}
