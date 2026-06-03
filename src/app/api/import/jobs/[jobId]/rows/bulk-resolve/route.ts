import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma";
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
//   scope  : needs_review | error | duplicate
// - 大量行でも updateMany 1 発で atomic に処理（部分成功なし）。
// - where の status フィルタで actionable 行のみ更新＝success 等は触らない・冪等。
// - AuditLog には action / status(scope) / count のみ（PII / rawData / 氏名 / 住所 /
//   errorMessage 本文は入れない）。
// 既存 per-row PATCH と同じ順序: updateMany → recalculateJobCounts → writeAuditLog。
//
// B4: scope="duplicate" を追加。重複候補（取込時に検出された重複行）のみを一括処理する。
// - 「duplicate」は ImportRowStatus ではない（enum=success/error/skipped/needs_review）。
//   そのため status へ直接渡さず、where を status から decouple して組み立てる:
//     duplicate → { jobId, status:"needs_review", errorMessage:{ startsWith:"重複" } }
//   これは detail route の duplicateCount と同一述語（csv/owner-csv 由来の重複）。
//   reception-property の「住所が既存物件と重複…」は prefix が「住所」のため**対象外**
//   （production の duplicateCount と一致／B4 v1 のスコープ外）。
// - action は既存どおり skip / mark_error。skip 時の data も既存と同一（"手動スキップ"）
//   なので解決後は errorMessage が「重複」始まりでなくなり、duplicateCount は単調減少する。
// - AuditLog detail.status には scope 値（"duplicate"）を格納（PII なし・既存3キー形状維持）。

const VALID_ACTIONS = ["skip", "mark_error"] as const;
const VALID_SCOPES = ["needs_review", "error", "duplicate"] as const;
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
        "scope は needs_review | error | duplicate のいずれかです",
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

    // scope を where に変換する（"duplicate" は status ではないため status へ直接渡さない）。
    //   needs_review / error : その status 行のみ（B3 既存挙動・status==scope）
    //   duplicate            : needs_review かつ errorMessage が「重複」始まり（重複候補のみ）
    const where: Prisma.ImportJobRowWhereInput =
      bulkScope === "duplicate"
        ? {
            jobId,
            status: "needs_review",
            errorMessage: { startsWith: "重複" },
          }
        : { jobId, status: bulkScope };

    // scope に一致する actionable 行のみを一括更新（success/skipped 等は where で除外）。
    const result = await prisma.importJobRow.updateMany({
      where,
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
