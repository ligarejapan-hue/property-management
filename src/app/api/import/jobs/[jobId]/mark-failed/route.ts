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

// ---------- PATCH /api/import/jobs/:jobId/mark-failed ----------
//
// 「processing のまま残っているジョブ」を手動で failed に確定する。
// 自動修復はせず、運用画面 (/import の異常ジョブセクション) からの
// 明示操作でのみ呼ばれる。
//
// ガード:
//   - 既に completed / failed / pending / rolled_back のジョブは 409 を返す
//     （誤って正常終了したジョブを failed に上書きしないため）
//   - status === "processing" のもののみ更新可
//
// 副作用:
//   - status = "failed"
//   - completedAt = now()
//   - successCount / errorCount は触らない（既存集計を破壊しないため）
//   - ImportJobRow には何も書き込まない（行情報は元の取込時のまま）
//
// 監査ログに「誰がいつどのジョブを failed 化したか」を残す。

export async function PATCH(
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

    const existing = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, jobType: true, fileName: true },
    });

    if (!existing) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }

    // 既に終了済みのジョブは保護。
    // pending / rolled_back も同様に対象外。
    if (existing.status !== "processing") {
      throw new ApiError(
        409,
        `このジョブは ${existing.status} 状態のため、failed 化できません`,
        "INVALID_STATE",
      );
    }

    const updated = await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        completedAt: new Date(),
      },
      include: {
        executor: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "import_job_mark_failed",
      targetTable: "import_jobs",
      targetId: jobId,
      detail: {
        jobType: existing.jobType,
        fileName: existing.fileName,
        previousStatus: "processing",
        reason: "manual_stuck_recovery",
      },
    });

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
