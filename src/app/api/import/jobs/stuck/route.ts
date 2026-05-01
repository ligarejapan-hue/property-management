import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// ---------- GET /api/import/jobs/stuck ----------
//
// 「processing のまま長時間放置されているジョブ」を返す。
// 過去の不具合（registry-pdf の Mode A NOT_FOUND 等）でジョブ作成だけが残り、
// status が "processing" → "completed/failed" に遷移できなかったケースを
// 運用上検出するための見える化エンドポイント。
//
// 判定:
//   status = "processing"
//   AND createdAt < (now - STUCK_THRESHOLD_MINUTES 分)
// 並び順: createdAt 昇順（古い順）。古いジョブから順に対処したい運用想定。
//
// 自動修復は行わない。クライアント側で「失敗にする」操作（PATCH .../mark-failed）
// を経由した場合のみ status を更新する。

const STUCK_THRESHOLD_MINUTES = 10;

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const thresholdAt = new Date(
      Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
    );

    const jobs = await prisma.importJob.findMany({
      where: {
        status: "processing",
        createdAt: { lt: thresholdAt },
      },
      include: {
        executor: { select: { id: true, name: true } },
        _count: { select: { rows: true } },
      },
      orderBy: { createdAt: "asc" },
      // 念のため上限。1000 件超のスタックは別の問題（運用通知）なので意図的に絞る。
      take: 200,
    });

    const now = Date.now();
    const data = jobs.map((job) => ({
      jobId: job.id,
      jobType: job.jobType,
      fileName: job.fileName,
      executor: job.executor,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      // 「経過時間（分）」: 切り捨てで返す。UI 側でそのまま表示できる。
      elapsedMinutes: Math.floor((now - job.createdAt.getTime()) / 60000),
      rowCount: job._count.rows,
    }));

    return apiResponse({
      thresholdMinutes: STUCK_THRESHOLD_MINUTES,
      data,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
