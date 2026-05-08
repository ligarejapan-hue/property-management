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
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import {
  isReceptionOwnerJobRow,
  parseRecoveredOwners,
  hasUsableOwnerInfo,
  calcPropertyUpdates,
} from "@/lib/reception-owner-link";

// ============================================================
// POST /api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner
// ------------------------------------------------------------
// 受付帳×所有者ジョブの needs_review 行に対して、ユーザが指定した
// Property に手動で紐づける。
//
// 適用条件 (厳格):
//   - jobType === "owner_csv"
//   - rawData に受付帳×所有者固有マーカ（所有者CSV物件住所 / matchKey / ownerCount）
//   - row.status === "needs_review"
//   - rawData["__owner_link_data"] から所有者氏名を 1件以上復元可能
//
// 処理 (transaction で原子的):
//   1. Property: 空欄項目のみ補完（既存値は破壊しない）
//   2. Owner: name + address で findFirst → 無ければ create
//   3. PropertyOwner: 同一 (propertyId, ownerId) が無ければ link
//   4. ImportJobRow: status=success, createdId=propertyId, errorMessage="手動紐づけ"
//   5. ImportJob: success/error カウント + status を再計算
//
// transaction commit 後（best-effort）:
//   - recordChanges (Property 変更履歴)
//   - writeAuditLog (action: reception_owner_manual_link)
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

    // Phase 1: needs_review のみ対象。error 行は弾く（CSV形式エラー等を success にしないため）。
    if (row.status !== "needs_review") {
      throw new ApiError(
        422,
        `この行は手動紐づけ対象ではありません（ステータス: ${row.status}）`,
        "VALIDATION_ERROR",
      );
    }

    const rawData = (row.rawData ?? null) as Record<string, unknown> | null;
    if (!isReceptionOwnerJobRow(row.job.jobType, rawData)) {
      throw new ApiError(
        422,
        "この API は受付帳×所有者ジョブの行のみ対象です",
        "VALIDATION_ERROR",
      );
    }

    const recoveredOwners = parseRecoveredOwners(rawData);
    if (!hasUsableOwnerInfo(recoveredOwners)) {
      throw new ApiError(
        422,
        "所有者情報が rawData から復元できません（取込時に所有者が紐づいていない、または古いジョブ）",
        "VALIDATION_ERROR",
      );
    }

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        lotNumber: true,
        buildingNumber: true,
        roomNo: true,
      },
    });
    if (!property) {
      throw new ApiError(404, "指定された物件が見つかりません", "NOT_FOUND");
    }

    // 受付帳行の rawData から地番/家屋番号を復元（取込時に保存済み）
    const reception = {
      lotNumber: stringOrNull(rawData?.lotNumber),
      buildingNumber: stringOrNull(rawData?.buildingNumber),
    };

    // owner upsert は name+address で検索 → 無ければ create
    // 補完用の roomNo は所有者群に部屋番号が含まれているかで判定
    // （ParsedOwnerRow.roomNo 由来。手動紐づけ時は rawData に保存していないため null）
    const propertyUpdates = calcPropertyUpdates(
      {
        lotNumber: property.lotNumber,
        buildingNumber: property.buildingNumber,
        roomNo: property.roomNo,
      },
      reception,
      null,
    );

    const beforeForChangeLog = {
      lotNumber: property.lotNumber ?? null,
      buildingNumber: property.buildingNumber ?? null,
      roomNo: property.roomNo ?? null,
    };

    let ownerCreatedCount = 0;
    let ownerLinkedCount = 0;

    // ---- transaction: 5 つの DB 操作を原子的にまとめる ----
    await prisma.$transaction(async (tx) => {
      // 1. Property 補完
      if (Object.keys(propertyUpdates).length > 0) {
        await tx.property.update({
          where: { id: propertyId },
          data: propertyUpdates,
        });
      }

      // 2-3. Owner upsert + PropertyOwner link （所有者ごと）
      for (const o of recoveredOwners) {
        const name = o.name.trim();
        if (!name) continue;
        const address = o.address;
        const zip = o.zip;

        let ownerId: string | null = null;
        let existingZip: string | null = null;
        if (address) {
          const hit = await tx.owner.findFirst({
            where: { name, address },
            select: { id: true, zip: true },
          });
          if (hit) {
            ownerId = hit.id;
            existingZip = hit.zip;
          }
        }
        if (!ownerId) {
          const hit = await tx.owner.findFirst({
            where: { name, address: null },
            select: { id: true, zip: true },
          });
          if (hit) {
            ownerId = hit.id;
            existingZip = hit.zip;
          }
        }

        if (!ownerId) {
          const created = await tx.owner.create({
            data: {
              name,
              ...(address ? { address } : {}),
              ...(zip ? { zip } : {}),
            },
            select: { id: true },
          });
          ownerId = created.id;
          ownerCreatedCount++;
        } else if (zip && !existingZip) {
          await tx.owner.update({
            where: { id: ownerId },
            data: { zip, version: { increment: 1 } },
          });
        }

        const existingLink = await tx.propertyOwner.findUnique({
          where: { propertyId_ownerId: { propertyId, ownerId } },
          select: { propertyId: true },
        });
        if (!existingLink) {
          await tx.propertyOwner.create({
            data: {
              propertyId,
              ownerId,
              relationship: "所有者",
              isPrimary: false,
            },
          });
          ownerLinkedCount++;
        }
      }

      // 4. ImportJobRow 更新
      await tx.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "success",
          createdId: propertyId,
          errorMessage: "手動紐づけ",
        },
      });

      // 5. ImportJob のカウンタと status を再計算
      const allRows = await tx.importJobRow.findMany({
        where: { jobId },
        select: { status: true },
      });
      const successCount = allRows.filter((r) => r.status === "success").length;
      const errorRows = allRows.filter((r) => r.status === "error").length;
      const reviewRows = allRows.filter((r) => r.status === "needs_review").length;
      const hasUnresolved = errorRows > 0 || reviewRows > 0;
      await tx.importJob.update({
        where: { id: jobId },
        data: {
          successCount,
          errorCount: errorRows + reviewRows,
          ...(hasUnresolved ? {} : { status: "completed", completedAt: new Date() }),
        },
      });
    });

    // ---- transaction commit 後 (best-effort、失敗しても主処理は成功) ----
    if (Object.keys(propertyUpdates).length > 0) {
      await recordChanges({
        targetTable: "properties",
        targetId: propertyId,
        changedBy: session.id,
        oldValues: beforeForChangeLog,
        newValues: { ...beforeForChangeLog, ...propertyUpdates },
        trackedFields: PROPERTY_TRACKED_FIELDS,
        source: "csv_import",
      });
    }

    await writeAuditLog({
      userId: session.id,
      action: "reception_owner_manual_link",
      targetTable: "import_job_rows",
      targetId: rowId,
      detail: {
        jobId,
        rowNumber: row.rowNumber,
        propertyId,
        ownerCreatedCount,
        ownerLinkedCount,
        propertyUpdatedFields: Object.keys(propertyUpdates),
      },
    });

    return apiResponse({
      ok: true,
      rowId,
      propertyId,
      ownerCreatedCount,
      ownerLinkedCount,
      propertyUpdatedFields: Object.keys(propertyUpdates),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
