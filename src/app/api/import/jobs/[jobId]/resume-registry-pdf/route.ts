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
import { writeAuditLog } from "@/lib/audit";
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
      select: { id: true, jobType: true, status: true },
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
    // pending行が0でも、ジョブが非終端(pending/processing)ならenqueueする。
    // 全件却下ジョブや、最終行処理後〜カウンタ確定前のクラッシュ(processing・
    // pending0)はpendingCount>0のみを条件にすると永久に確定されず取り残される
    // (@codex指摘)。worker側のprocessJobはpending行が無くてもカウンタを
    // 再計算してstatusを確定する冪等実装のため、非終端ジョブは呼び直して良い。
    const shouldEnqueue =
      pendingCount > 0 || job.status === "pending" || job.status === "processing";
    if (shouldEnqueue) {
      enqueueRegistryPdfBulkJob(jobId);
      try {
        await writeAuditLog({
          userId: session.id,
          action: "registry_pdf_bulk_resume",
          targetTable: "import_jobs",
          targetId: jobId,
          detail: { pendingCount },
        });
      } catch (auditError) {
        console.error("registry-pdf-bulk: resume audit log failed:", auditError);
      }
    }
    return apiResponse({ ok: true, pendingCount });
  } catch (error) {
    return handleApiError(error);
  }
}
