import { timingSafeEqual } from "crypto";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { runDriveSync } from "@/lib/drive/sync-run";
import { liveRunDeps } from "@/lib/drive/sync-live";
import { autoLinkDue, autoLinkIfConnected } from "@/lib/drive/auto-link";
import { getDriveClient } from "@/lib/drive/connection";

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
/** 自動の紐づけ(1時間に1回・見回りの前に=新しく紐づけたフォルダもその回から見回る)。再起動で 0 に戻る=起動後の最初の回に1度。 */
let lastAutoLinkAt = 0;

async function autoLinkIfDue(): Promise<void> {
  const now = Date.now();
  if (!autoLinkDue(lastAutoLinkAt, now)) return;
  lastAutoLinkAt = now;
  try {
    const r = await autoLinkIfConnected({ loadConnection: liveRunDeps().loadConnection, getClient: () => getDriveClient() });
    console.log(
      "skipped" in r
        ? `[drive-auto-link] skipped=${r.skipped}`
        : `[drive-auto-link] linked=${r.linked} planned=${r.planned}${r.truncated ? " truncated" : ""}`,
    );
  } catch (e) {
    // 未接続・再接続が必要なときもここ(見回り本体が状態を残す)。名前は出さない
    console.log(`[drive-auto-link] error=${e instanceof Error ? e.name : "unknown"}`);
  }
}

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
      await autoLinkIfDue();
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
