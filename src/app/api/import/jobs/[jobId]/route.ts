import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  summaryFromStatusCounts,
  type StatusCounts,
} from "@/lib/import-summary";

// ---------- GET /api/import/jobs/:jobId ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // 段階A(PR-A): rows 全件返却は維持しつつ、5 区分サマリを **サーバ側で**
    // 算出して additive に返す。これにより詳細画面は summary を全行配列
    // (job.rows) から JS 集計せず job.summary を真実として使えるようになり、
    // 後続の rows ページング(PR-B)で件数が現ページのみに化ける事故を防ぐ。
    //   ① groupBy(by:["status"]) で status 別件数
    //   ② groupBy(by:["jobId"]) で「更新」success 件数
    //      （success かつ errorMessage が「更新」始まり = isUpdateMessage 規約）
    // PR#98 一覧 route と同じ summaryFromStatusCounts() を再利用する。
    // 存在しない jobId への groupBy は空配列を返すだけで、404 は下で送出する。
    const [job, statusGroups, updatedGroups] = await Promise.all([
      prisma.importJob.findUnique({
        where: { id: jobId },
        include: {
          executor: { select: { id: true, name: true } },
          rows: {
            orderBy: { rowNumber: "asc" },
          },
        },
      }),
      prisma.importJobRow.groupBy({
        by: ["status"],
        where: { jobId },
        _count: { _all: true },
      }),
      prisma.importJobRow.groupBy({
        by: ["jobId"],
        where: {
          jobId,
          status: "success",
          // null は startsWith にマッチしないため更新扱いされない。
          errorMessage: { startsWith: "更新" },
        },
        _count: { _all: true },
      }),
    ]);

    if (!job) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }

    // groupBy は 0 件 status を返さないため未指定キーは 0 埋め扱いになる。
    const statusCounts: StatusCounts = {};
    for (const g of statusGroups) {
      statusCounts[g.status] = g._count._all;
    }
    const updatedCount = updatedGroups[0]?._count._all ?? 0;
    const summary = summaryFromStatusCounts(statusCounts, updatedCount);

    return apiResponse({ ...job, summary });
  } catch (error) {
    return handleApiError(error);
  }
}
