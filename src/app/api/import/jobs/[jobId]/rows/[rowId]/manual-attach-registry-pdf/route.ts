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
import { assertImportJobVisible } from "@/lib/import-job-guard";
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
// claim(行の確定)は最後の $transaction まで遅延させる
// (process-row.ts のワーカーpathと同じ規約)。storage/attachment の
// 作成中は行(DB)に一切触れず、needs_review のまま無傷で残す。
// こうすることで、storage作業〜確定txの間にプロセスがクラッシュ/
// 再起動しても、行は "needs_review + createdId=null" のままなので
// 再試行可能。
// (@codex 3巡目 P2: 従来は「事前claimをcommit→storage作業→最終tx確定」
//  の順序で、claim commit後〜確定/revert前にクラッシュすると行が
//  "needs_review + createdId≠null" のまま残り、本routeの事前チェック
//  [createdId truthyで422] により永久に手動添付不能になっていた)。
//
// トレードオフ: クラッシュ位置が「添付作成後・確定tx前」だと、
// 作成済みの添付(孤児)は物件に残ったままになる。再試行すると
// 別の添付がもう1本作られ、二重添付になり得る。この孤児/二重添付は
// UIの添付削除から手動で片付けられる(行が永久ロックされるより軽微、
// という判断)。
// ============================================================

interface RequestBody {
  propertyId?: string;
}

// Prisma の @db.Uuid カラムに不正形式を渡すと P2023(500)になるため、
// DBに問い合わせる前にUUID形式を検証し、不正入力は422で弾く。
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (!UUID_RE.test(propertyId)) {
      throw new ApiError(422, "propertyId の形式が不正です", "VALIDATION_ERROR");
    }

    const row = await prisma.importJobRow.findUnique({
      where: { id: rowId },
      include: { job: { select: { id: true, jobType: true, executedBy: true } } },
    });
    if (!row || row.jobId !== jobId) {
      throw new ApiError(404, "行が見つかりません", "NOT_FOUND");
    }

    // 他の担当者が実行した取込は見せない(2026-08-02 監査)。
    assertImportJobVisible(row.job, session.id, perms);
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

    // storage/attachment の作成。claim(DBの行更新)はまだ行わない
    // (上のコメントの通り、確定は最後の $transaction に統合する)。
    const storage = getStorage();
    let attachmentId: string;
    let uploadedKey: string | null = null;
    try {
      const staged = await storage.read(stagedKey);
      if (!staged) {
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
      throw err;
    }

    // 確定 + ジョブカウンタ再計算(原子化)。claim(atomic updateMany: where
    // needs_review かつ createdId null)をこの $transaction の内部で行うことで、
    // 「行確定」と「カウンタ再計算」だけでなく「claimの成立可否」までも
    // 1本のtxにまとめる。claim.count!==1 は並行操作との競合(または対象行の
    // 状態変化)を意味し、409で弾く。
    try {
      await prisma.$transaction(async (tx) => {
        const claim = await tx.importJobRow.updateMany({
          where: { id: rowId, jobId, status: "needs_review", createdId: null },
          data: {
            status: "success",
            errorMessage: "手動添付",
            createdId: propertyId,
          },
        });
        if (claim.count !== 1) {
          throw new ApiError(
            409,
            "別の操作で既に処理済みか、対象行が変更されました",
            "CONFLICT",
          );
        }
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
      // best-effort undo: 添付レコード→storage実体 の順に戻す。
      // claimはtx内でのみ行っており、tx失敗時(409のthrowも含む)は
      // Prisma がtx全体をロールバックするため、行側の巻き戻しは不要
      // (revertClaimは廃止)。
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
