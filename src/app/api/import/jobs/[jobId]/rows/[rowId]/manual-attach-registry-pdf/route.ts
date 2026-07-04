import { randomUUID } from "node:crypto";
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
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";
import {
  getStorage,
  validateFile,
  ALLOWED_ATTACHMENT_MIMES,
} from "@/lib/storage";

// ============================================================
// POST /api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf
// ------------------------------------------------------------
// 所有者事項PDF一括ジョブの needs_review 行(未突合PDF)を、
// ユーザが指定した Property に手動で添付する。
//
// manual-link-reception-owner と同じ規約:
//   - atomic claim(updateMany where status/createdId 条件)で並行実行を排除
//   - 完了後にジョブのカウンタと status を再計算
//   - 監査ログは commit 後 best-effort
// storage 操作はトランザクションに入れられないため、
// claim → storage/attachment → 失敗時は claim を戻す、の順で行う。
// ============================================================

interface RequestBody {
  propertyId?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; rowId: string }> },
) {
  try {
    const { jobId, rowId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const propertyId = body.propertyId?.trim();
    if (!propertyId) {
      throw new ApiError(422, "propertyId は必須です", "VALIDATION_ERROR");
    }

    const row = await prisma.importJobRow.findUnique({
      where: { id: rowId },
      include: { job: { select: { id: true, jobType: true } } },
    });
    if (!row || row.jobId !== jobId) {
      throw new ApiError(404, "行が見つかりません", "NOT_FOUND");
    }
    if (row.job.jobType !== "registry_pdf_bulk") {
      throw new ApiError(
        422,
        "このAPIは所有者事項PDF一括ジョブの行のみ対象です",
        "VALIDATION_ERROR",
      );
    }
    if (row.status !== "needs_review" || row.createdId) {
      throw new ApiError(
        422,
        `この行は手動添付の対象ではありません(ステータス: ${row.status})`,
        "VALIDATION_ERROR",
      );
    }
    const raw = ((row.rawData ?? {}) as Record<string, unknown>) ?? {};
    const stagedKey = typeof raw.stagedKey === "string" ? raw.stagedKey : "";
    const fileName =
      typeof raw.fileName === "string" && raw.fileName !== ""
        ? raw.fileName
        : "registry.pdf";
    if (!stagedKey) {
      throw new ApiError(
        422,
        "保管中のPDFが見つかりません(取込データが不完全です)",
        "VALIDATION_ERROR",
      );
    }

    const target = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { createdBy: true, assignedTo: true },
    });
    if (!target) {
      throw new ApiError(404, "指定された物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, target)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    // ATOMIC CLAIM: 並行リクエストは最初の1本だけが通過する
    const claim = await prisma.importJobRow.updateMany({
      where: { id: rowId, jobId, status: "needs_review", createdId: null },
      data: { createdId: propertyId },
    });
    if (claim.count !== 1) {
      throw new ApiError(
        409,
        "別の操作で既に処理済みか、対象行が変更されました",
        "CONFLICT",
      );
    }

    const revertClaim = async () => {
      try {
        await prisma.importJobRow.updateMany({
          where: { id: rowId, status: "needs_review", createdId: propertyId },
          data: { createdId: null },
        });
      } catch (e) {
        console.error("manual-attach-registry-pdf: claim revert failed:", e);
      }
    };

    const storage = getStorage();
    let attachmentId: string;
    let uploadedKey: string | null = null;
    try {
      const staged = await storage.read(stagedKey);
      if (!staged) {
        await revertClaim();
        throw new ApiError(
          422,
          "保管中のPDFを読み取れませんでした(整理済みの可能性があります)",
          "VALIDATION_ERROR",
        );
      }
      const buf = staged.body;
      const validationError = validateFile(
        buf.length,
        "application/pdf",
        ALLOWED_ATTACHMENT_MIMES,
      );
      if (validationError) {
        await revertClaim();
        throw new ApiError(422, validationError, "VALIDATION_ERROR");
      }
      const key = `properties/${propertyId}/registry/${Date.now()}-${randomUUID()}.pdf`;
      const uploaded = await storage.upload(buf, {
        key,
        mimeType: "application/pdf",
        fileName,
      });
      uploadedKey = uploaded.key;
      const attachment = await prisma.attachment.create({
        data: {
          targetType: "property",
          targetId: propertyId,
          propertyId,
          type: "registry",
          fileName,
          fileUrl: uploaded.url,
          fileSize: buf.length,
          mimeType: "application/pdf",
          uploadedBy: session.id,
        },
        select: { id: true },
      });
      attachmentId = attachment.id;
    } catch (err) {
      if (uploadedKey) {
        try {
          await storage.delete(uploadedKey);
        } catch (delErr) {
          console.error(
            "manual-attach-registry-pdf: orphan cleanup failed:",
            delErr,
          );
        }
      }
      if (!(err instanceof ApiError)) {
        await revertClaim();
      }
      throw err;
    }

    // 行確定 + ジョブカウンタ再計算(原子化)。
    // $transaction により、途中失敗時は行確定(①)ごとロールバックされるため、
    // catch 到達時は常に「行=needs_review + claim保持」= 下のundo(添付取消→claim復元)が
    // 全ケースで正しく、正当な添付を壊す経路が存在しない。
    try {
      await prisma.$transaction(async (tx) => {
        await tx.importJobRow.update({
          where: { id: rowId },
          data: { status: "success", errorMessage: "手動添付" },
        });
        const allRows = await tx.importJobRow.findMany({
          where: { jobId },
          select: { status: true },
        });
        const successCount = allRows.filter(
          (r) => r.status === "success",
        ).length;
        const errorRows = allRows.filter((r) => r.status === "error").length;
        const reviewRows = allRows.filter(
          (r) => r.status === "needs_review",
        ).length;
        const pendingRows = allRows.filter(
          (r) => r.status === "pending",
        ).length;
        const hasUnresolved =
          errorRows > 0 || reviewRows > 0 || pendingRows > 0;
        await tx.importJob.update({
          where: { id: jobId },
          data: {
            successCount,
            errorCount: errorRows + reviewRows,
            ...(hasUnresolved
              ? {}
              : { status: "completed", completedAt: new Date() }),
          },
        });
      });
    } catch (finalizeErr) {
      // best-effort undo: 添付レコード→storage実体→claim の順に戻す
      try {
        await prisma.attachment.delete({ where: { id: attachmentId } });
      } catch (e) {
        console.error(
          "manual-attach-registry-pdf: attachment undo failed:",
          e,
        );
      }
      try {
        await storage.delete(uploadedKey!);
      } catch (e) {
        console.error(
          "manual-attach-registry-pdf: uploaded blob undo failed:",
          e,
        );
      }
      await revertClaim();
      throw finalizeErr;
    }

    try {
      await storage.delete(stagedKey);
    } catch (e) {
      console.error("manual-attach-registry-pdf: staging delete failed:", e);
    }
    try {
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_manual_attach",
        targetTable: "import_job_rows",
        targetId: rowId,
        detail: { jobId, rowNumber: row.rowNumber, propertyId, attachmentId },
      });
    } catch (e) {
      console.error("manual-attach-registry-pdf: audit failed (non-fatal):", e);
    }

    return apiResponse({ ok: true, rowId, propertyId, attachmentId });
  } catch (error) {
    return handleApiError(error);
  }
}
