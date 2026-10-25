import { timingSafeEqual } from "crypto";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { runDriveSync } from "@/lib/drive/sync-run";
import { liveRunDeps } from "@/lib/drive/sync-live";

/**
 * POST /api/drive/sync-run — Google ドライブの見回り(第2段b・timer `pm-drive-sync` 5分ごと)。
 *
 * 作りは Web プッシュの送信口(`/api/notifications/push-run`)と同型:
 * - `DRIVE_SYNC_SECRET` 未設定なら **503(休眠)**・header `x-drive-sync-secret` 不一致は 403
 * - 見回りは同時に1つ(このプロセスの印。前のが終わっていなければ 409)。重なっても
 *   添付の写しは1つ(markCopied の条件つき更新)・台帳は drive_file_id で1行
 * - 1回の読み書きは全物件で 20 件まで。前回の続きの物件から回る
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスが必要(無いと 307)
 * - 応答・journal は件数だけ(ファイル名・フォルダ名は出さない)
 */
const BUDGET = 20;
let running = false;
let startAt = 0;

export async function POST(request: Request) {
  try {
    const secret = process.env.DRIVE_SYNC_SECRET;
    if (!secret) throw new ApiError(503, "ドライブの見回りは未設定です", "NOT_CONFIGURED");
    const headerBuf = Buffer.from(request.headers.get("x-drive-sync-secret") ?? "");
    const secretBuf = Buffer.from(secret);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (running) throw new ApiError(409, "前の見回りがまだ動いています", "ALREADY_RUNNING");
    running = true;
    try {
      const result = await runDriveSync(liveRunDeps(), { budget: BUDGET, startAt });
      startAt = result.nextStartAt;
      console.log(
        `[drive-sync] links=${result.links} errors=${result.linkErrors} ` +
          Object.entries(result.totals)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") +
          (result.skipped ? ` skipped=${result.skipped}` : ""),
      );
      return apiResponse(result);
    } finally {
      running = false;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
