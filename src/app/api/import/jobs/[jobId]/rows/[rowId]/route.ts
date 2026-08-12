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
import { getStorage } from "@/lib/storage";

import {
  buildPropertyCreateData,
  buildOwnerCreateData,
  mapOwnerRawData,
} from "@/lib/import-row-field-map";
import { resolveAddressPairBackfill } from "@/lib/owner-address-backfill";

// ---------- PATCH /api/import/jobs/:jobId/rows/:rowId ----------

export async function PATCH(
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
    const { action, targetId, editedData } = body as {
      action: "create_new" | "link_existing" | "skip" | "mark_error";
      targetId?: string;
      editedData?: Record<string, string>;
    };

    if (!action) {
      throw new ApiError(422, "action は必須です", "VALIDATION_ERROR");
    }

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

    if (row.status !== "needs_review" && row.status !== "error") {
      throw new ApiError(
        422,
        "この行は解決対象ではありません（ステータス: " + row.status + "）",
        "VALIDATION_ERROR",
      );
    }

    let updatedRow;

    if (action === "create_new") {
      const sourceData = editedData ?? (row.rawData as Record<string, string>);

      let createdRecord: { id: string };

      if (row.job.jobType === "property_csv") {
        const createData = buildPropertyCreateData(sourceData, session.id);
        createdRecord = await prisma.property.create({
          data: createData as Parameters<typeof prisma.property.create>[0]["data"],
        });
      } else if (row.job.jobType === "owner_csv") {
        const createData = buildOwnerCreateData(sourceData);
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
          "このジョブタイプは create_new に対応していません",
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
    } else if (action === "link_existing") {
      if (!targetId) {
        throw new ApiError(422, "targetId は必須です", "VALIDATION_ERROR");
      }

      // Verify the target exists
      if (row.job.jobType === "property_csv") {
        const property = await prisma.property.findUnique({
          where: { id: targetId },
          select: { id: true },
        });
        if (!property) {
          throw new ApiError(404, "指定された物件が見つかりません", "NOT_FOUND");
        }
      } else if (row.job.jobType === "owner_csv") {
        const owner = await prisma.owner.findUnique({
          where: { id: targetId },
          select: { id: true },
        });
        if (!owner) {
          throw new ApiError(404, "指定された所有者が見つかりません", "NOT_FOUND");
        }
      } else if (row.job.jobType === "registry_pdf_bulk") {
        throw new ApiError(
          422,
          "このジョブの行は専用の手動添付APIを使用してください",
          "VALIDATION_ERROR",
        );
      }

      // ⚠「行の確保 → 相手の補完 → 履歴 → 行の完了」を**1つの tx** で行う（設計 §6.3(3)）。
      //   2人が同じ行を別々の相手に解決すると、両方が相手を書き換えるのに行に残るのは
      //   最後の1つだけになる。途中で失敗すると「相手だけ書き換わって行も履歴も無い」
      //   状態が残る。確保できなければ 409（他の担当者が解決済み）。
      updatedRow = await prisma.$transaction(async (tx) => {
        const claim = await tx.importJobRow.updateMany({
          where: { id: rowId, status: { in: ["needs_review", "error"] } },
          data: {
            status: "success",
            createdId: targetId,
            errorMessage: null,
          },
        });
        if (claim.count === 0) {
          throw new ApiError(
            409,
            "他の担当者が既にこの行を解決しています",
            "ROW_ALREADY_RESOLVED",
          );
        }

        if (row.job.jobType === "owner_csv") {
          // 取込の値で、選んだ所有者の**空いている欄だけ**を補完する。
          const sourceData =
            editedData ?? (row.rawData as Record<string, string>);
          const mapped = mapOwnerRawData(sourceData);
          // 所有者の行をロックしてから読み直す（設計 §6.3(2)）。
          const locked = await tx.owner.updateMany({
            where: { id: targetId, isArchived: false },
            data: { updatedAt: new Date() },
          });
          if (locked.count > 0) {
            const fresh = await tx.owner.findUnique({
              where: { id: targetId },
              select: {
                zip: true,
                address: true,
                currentZip: true,
                currentAddress: true,
              },
            });
            if (fresh) {
              const registryPatch = resolveAddressPairBackfill(
                { zip: fresh.zip, address: fresh.address },
                { zip: mapped.zip ?? null, address: mapped.address ?? null },
              );
              const currentPatch = resolveAddressPairBackfill(
                { zip: fresh.currentZip, address: fresh.currentAddress },
                {
                  zip: mapped.currentZip ?? null,
                  address: mapped.currentAddress ?? null,
                },
              );
              const fieldPatch: Record<string, string> = {
                ...registryPatch,
                ...(currentPatch.zip ? { currentZip: currentPatch.zip } : {}),
                ...(currentPatch.address
                  ? { currentAddress: currentPatch.address }
                  : {}),
              };
              if (Object.keys(fieldPatch).length > 0) {
                await tx.owner.update({
                  where: { id: targetId },
                  data: { ...fieldPatch, version: { increment: 1 } },
                });
                const before: Record<string, string | null> = {
                  zip: fresh.zip,
                  address: fresh.address,
                  currentZip: fresh.currentZip,
                  currentAddress: fresh.currentAddress,
                };
                await tx.changeLog.createMany({
                  data: Object.entries(fieldPatch).map(
                    ([fieldName, newValue]) => ({
                      targetTable: "owners",
                      targetId: targetId,
                      fieldName,
                      oldValue: before[fieldName] ?? null,
                      newValue,
                      source: "csv_import" as const,
                      changedBy: session.id,
                    }),
                  ),
                });
              }
            }
          }
        }

        return tx.importJobRow.findUniqueOrThrow({ where: { id: rowId } });
      });
    } else if (action === "skip") {
      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "skipped",
          errorMessage: "手動スキップ",
        },
      });
    } else if (action === "mark_error") {
      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "error",
          errorMessage: "手動エラー確定",
        },
      });
    } else {
      throw new ApiError(422, "無効な action です", "VALIDATION_ERROR");
    }

    // registry_pdf_bulk 行が skip/mark_error で確定した場合、staging(所有者PII)を
    // best-effortで削除する。この種の行はneeds_review/errorのまま放置されず
    // 手動添付対象からも外れる袋小路のため、保管しておく理由が無い。
    if (
      row.job.jobType === "registry_pdf_bulk" &&
      (action === "skip" || action === "mark_error")
    ) {
      const raw = (row.rawData ?? {}) as Record<string, unknown>;
      const stagedKey = typeof raw.stagedKey === "string" ? raw.stagedKey : "";
      if (stagedKey) {
        try {
          await getStorage().delete(stagedKey);
        } catch (e) {
          console.error("import row resolve: staging delete failed:", e);
        }
      }
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
        action,
        rowNumber: row.rowNumber,
        jobId,
      },
    });

    return apiResponse(updatedRow);
  } catch (error) {
    return handleApiError(error);
  }
}
