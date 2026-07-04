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
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";

// ============================================================
// POST /api/import/jobs/[jobId]/resume-registry-pdf
// ------------------------------------------------------------
// 所有者事項PDF一括ジョブの未処理(pending)行を再開する。
// サーバ再起動でインプロセスワーカーの待機列が消えた場合の復旧口。
// 行状態はDBに永続化されているため、enqueueし直すだけでよい
// (処理済み行は process-row 側の pending 条件で自然にスキップされる)。
// ============================================================

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }

    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true, jobType: true },
    });
    if (!job) {
      throw new ApiError(404, "取込ジョブが見つかりません", "NOT_FOUND");
    }
    if (job.jobType !== "registry_pdf_bulk") {
      throw new ApiError(
        422,
        "このAPIは所有者事項PDF一括ジョブのみ対象です",
        "VALIDATION_ERROR",
      );
    }

    const pendingCount = await prisma.importJobRow.count({
      where: { jobId, status: "pending" },
    });
    if (pendingCount > 0) {
      enqueueRegistryPdfBulkJob(jobId);
    }
    return apiResponse({ ok: true, pendingCount });
  } catch (error) {
    return handleApiError(error);
  }
}
