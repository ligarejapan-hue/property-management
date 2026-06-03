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
import { recalculateJobCounts } from "@/lib/import-job-counts";

// ---------- POST /api/import/jobs/:jobId/rows/bulk-resolve ----------
//
// B3: scope に一致する **全 actionable 行** を server-side where + updateMany で
// 一括解決する。client から ID 一覧は受け取らない（現ページ限定を避ける）。
//   action : skip | mark_error
//   scope  : needs_review | error
// - 大量行でも updateMany 1 発で atomic に処理（部分成功なし）。
// - where の status フィルタで actionable 行のみ更新＝success 等は触らない・冪等。
// - AuditLog には action / status(scope) / count のみ（PII / rawData / 氏名 / 住所 /
//   errorMessage 本文は入れない）。
// 既存 per-row PATCH と同じ順序: updateMany → recalculateJobCounts → writeAuditLog。

const VALID_ACTIONS = ["skip", "mark_error"] as const;
const VALID_SCOPES = ["needs_review", "error"] as const;
type BulkAction = (typeof VALID_ACTIONS)[number];
type BulkScope = (typeof VALID_SCOPES)[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json().catch(() => ({}));
    const { action, scope } = body as { action?: string; scope?: string };

    if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
      throw new ApiError(
        422,
        "action は skip | mark_error のいずれかです",
        "VALIDATION_ERROR",
      );
    }
    if (!scope || !(VALID_SCOPES as readonly string[]).includes(scope)) {
      throw new ApiError(
        422,
        "scope は needs_review | error のいずれかです",
        "VALIDATION_ERROR",
      );
    }
    const bulkAction = action as BulkAction;
    const bulkScope = scope as BulkScope;

    // ジョブ存在確認（404）。
    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (!job) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }

    // scope に一致する actionable 行のみを一括更新（success/skipped 等は where で除外）。
    const result = await prisma.importJobRow.updateMany({
      where: { jobId, status: bulkScope },
      data:
        bulkAction === "skip"
          ? { status: "skipped", errorMessage: "手動スキップ" }
          : { status: "error", errorMessage: "手動エラー確定" },
    });
    const affectedCount = result.count;

    // ジョブ集計を再計算（既存 per-row と同じ・非 transaction）。
    await recalculateJobCounts(jobId);

    // 監査（PII なし: action / status(scope) / count のみ）。
    await writeAuditLog({
      userId: session.id,
      action: "import_rows_bulk_resolve",
      targetTable: "import_jobs",
      targetId: jobId,
      detail: {
        action: bulkAction,
        status: bulkScope,
        count: affectedCount,
      },
    });

    return apiResponse({ affectedCount });
  } catch (error) {
    return handleApiError(error);
  }
}
