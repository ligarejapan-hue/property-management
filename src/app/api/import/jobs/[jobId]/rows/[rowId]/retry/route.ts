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
import { assertImportJobMutable } from "@/lib/import-job-guard";
import { writeAuditLog } from "@/lib/audit";
import { findDuplicateOwner } from "@/lib/owner-dedup";
import { recalculateJobCounts } from "@/lib/import-job-counts";

import {
  buildPropertyCreateData,
  buildOwnerCreateData,
} from "@/lib/import-row-field-map";

// ---------- POST /api/import/jobs/:jobId/rows/:rowId/retry ----------

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

    const body = await request.json();
    const { editedData } = body as {
      editedData?: Record<string, string>;
    };

    // Fetch the row and verify it belongs to this job
    const row = await prisma.importJobRow.findUnique({
      where: { id: rowId },
      include: { job: true },
    });

    if (!row || row.jobId !== jobId) {
      throw new ApiError(404, "行が見つかりません", "NOT_FOUND");
    }

    // 他の担当者が実行した取込は**変更させない**(2026-08-02 監査)。
    // 閲覧だけの import:read_all では通らず、import:manage が必要。
    assertImportJobMutable(row.job, session.id, perms);

    if (row.status !== "error") {
      throw new ApiError(
        422,
        "リトライはエラー行のみ可能です（ステータス: " + row.status + "）",
        "VALIDATION_ERROR",
      );
    }

    // Merge editedData over rawData if provided
    const mergedData: Record<string, string> = {
      ...(row.rawData as Record<string, string>),
      ...(editedData ?? {}),
    };

    let updatedRow;

    try {
      let createdRecord: { id: string };

      if (row.job.jobType === "property_csv") {
        const createData = buildPropertyCreateData(mergedData, session.id);
        createdRecord = await prisma.property.create({
          data: createData as Parameters<typeof prisma.property.create>[0]["data"],
        });
      } else if (row.job.jobType === "owner_csv") {
        const createData = buildOwnerCreateData(mergedData);
        const dup = await findDuplicateOwner({
          name: createData.name as string,
          address: createData.address as string | undefined,
          phone: createData.phone as string | undefined,
        });
        if (dup) {
          // PII（name/address/phone/rawData）はレスポンスに含めない。existingOwnerId のみ返す。
          return apiResponse(
            {
              error: {
                message: "既存所有者候補が存在します",
                code: "DUPLICATE_OWNER",
                existingOwnerId: dup.id,
              },
            },
            409,
          );
        }
        createdRecord = await prisma.owner.create({
          data: createData as Parameters<typeof prisma.owner.create>[0]["data"],
        });
      } else {
        throw new ApiError(
          422,
          "このジョブタイプはリトライに対応していません",
          "VALIDATION_ERROR",
        );
      }

      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "success",
          createdId: createdRecord.id,
          errorMessage: null,
        },
      });
    } catch (err) {
      // If it's an ApiError, re-throw it
      if (err instanceof ApiError) throw err;

      // Otherwise, it's a creation failure - update the error message
      const newErrorMessage = err instanceof Error ? err.message : "不明なエラー";
      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          errorMessage: newErrorMessage,
        },
      });
    }

    // Recalculate job counts
    await recalculateJobCounts(jobId);

    // Write audit log
    await writeAuditLog({
      userId: session.id,
      action: "import_row_resolve",
      targetTable: "import_job_rows",
      targetId: rowId,
      detail: {
        action: "retry",
        rowNumber: row.rowNumber,
        jobId,
      },
    });

    return apiResponse(updatedRow);
  } catch (error) {
    return handleApiError(error);
  }
}
