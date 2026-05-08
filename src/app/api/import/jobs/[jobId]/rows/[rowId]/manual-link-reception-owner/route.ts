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
  isRowEligibleForManualLink,
} from "@/lib/reception-owner-link";

// ============================================================
// POST /api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner
// ------------------------------------------------------------
// 受付帳×所有者ジョブの needs_review 行に対して、ユーザが指定した
// Property に手動で紐づける。
//
// 適用条件 (厳格):
//   - jobType === "owner_csv"
//   - rawData に受付帳×所有者固有マーカ（所有者CSV物件住所 / ownerCount / __owner_link_data）
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

    // Phase 1: pre-check で早期失敗させる（status / createdId 両方を判定）。
    // ただし最終的な競合解消は transaction 内の atomic claim (updateMany) で行うため、
    // ここを通過しても並行リクエストでは claim 段階で 409 になり得る。
    if (
      !isRowEligibleForManualLink({
        status: row.status,
        createdId: row.createdId,
      })
    ) {
      if (row.createdId) {
        throw new ApiError(422, "この行は既に紐づけ済みです", "VALIDATION_ERROR");
      }
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

    // 受付帳行の rawData から地番/家屋番号を復元（取込時に保存済み）
    const reception = {
      lotNumber: stringOrNull(rawData?.lotNumber),
      buildingNumber: stringOrNull(rawData?.buildingNumber),
    };

    let ownerCreatedCount = 0;
    let ownerLinkedCount = 0;
    // Property の最新値は transaction 内 (atomic claim 成功後) に読み直して
    // 「空欄のみ補完」の保証を担保する。別 row が並行で同じ Property を更新しても、
    // claim 成功後の readback で最新値を見て updates を再計算する。
    let propertyUpdates: ReturnType<typeof calcPropertyUpdates> = {};
    let beforeForChangeLog: {
      lotNumber: string | null;
      buildingNumber: string | null;
      roomNo: string | null;
    } = { lotNumber: null, buildingNumber: null, roomNo: null };

    // ---- transaction: atomic claim + DB 操作を原子的にまとめる ----
    await prisma.$transaction(async (tx) => {
      // 0. ATOMIC CLAIM: 同一 row への並行リクエスト時、最初の 1 本だけが count=1 で
      //    通過する。残りは count=0 で 409。後続失敗時は transaction rollback で
      //    createdId のセットも戻る（claim 自体も巻き戻る）。
      const claim = await tx.importJobRow.updateMany({
        where: {
          id: rowId,
          jobId,
          status: "needs_review",
          createdId: null,
        },
        data: {
          createdId: propertyId,
        },
      });
      if (claim.count !== 1) {
        throw new ApiError(
          409,
          "別の操作で既に紐づけ済みか、対象行が変更されました",
          "CONFLICT",
        );
      }

      // 1. Property 最新読み直し → updates 再計算 → 補完。
      //    transaction 外の読取結果を使うと、別 row が同じ Property に並行で
      //    補完済みでも上書きしてしまう恐れがあるため、claim 成功後にここで
      //    最新値を確定させる。
      //    手動紐づけ時 roomNo の補完源 (ParsedOwnerRow.roomNo) は rawData に
      //    保存していないため null 固定。
      const fresh = await tx.property.findUnique({
        where: { id: propertyId },
        select: { lotNumber: true, buildingNumber: true, roomNo: true },
      });
      if (!fresh) {
        throw new ApiError(404, "指定された物件が見つかりません", "NOT_FOUND");
      }
      beforeForChangeLog = {
        lotNumber: fresh.lotNumber ?? null,
        buildingNumber: fresh.buildingNumber ?? null,
        roomNo: fresh.roomNo ?? null,
      };
      propertyUpdates = calcPropertyUpdates(
        {
          lotNumber: fresh.lotNumber,
          buildingNumber: fresh.buildingNumber,
          roomNo: fresh.roomNo,
        },
        reception,
        null,
      );
      if (Object.keys(propertyUpdates).length > 0) {
        await tx.property.update({
          where: { id: propertyId },
          data: propertyUpdates,
        });
      }

      // 2. Owner upsert（所有者ごと）。
      //    NOTE: Owner にスキーマ unique 制約がないため、極めて高い並行性下では
      //    重複 Owner レコード生成の可能性が残る（Codex 指摘）。今回 migration は
      //    追加しないため完全には解消していない。同一 row 二重実行は上記 atomic
      //    claim で防止済み。
      const ownerIds: string[] = [];
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
        ownerIds.push(ownerId);
      }

      // 3. PropertyOwner link （冪等）。
      //    createMany + skipDuplicates により、既存 link がある場合は素通りし、
      //    並行リクエストで unique constraint error にならない。
      //    count は今回 INSERT された行数 → ownerLinkedCount として反映。
      if (ownerIds.length > 0) {
        const linkResult = await tx.propertyOwner.createMany({
          data: ownerIds.map((ownerId) => ({
            propertyId,
            ownerId,
            relationship: "所有者",
            isPrimary: false,
          })),
          skipDuplicates: true,
        });
        ownerLinkedCount = linkResult.count;
      }

      // 4. ImportJobRow を最終 status に確定（createdId は claim 時点でセット済み）
      await tx.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "success",
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
    // recordChanges / writeAuditLog 失敗は API 全体の失敗にはしない（log は補助情報）。
    if (Object.keys(propertyUpdates).length > 0) {
      try {
        await recordChanges({
          targetTable: "properties",
          targetId: propertyId,
          changedBy: session.id,
          oldValues: beforeForChangeLog,
          newValues: { ...beforeForChangeLog, ...propertyUpdates },
          trackedFields: PROPERTY_TRACKED_FIELDS,
          source: "csv_import",
        });
      } catch (logErr) {
        console.error(
          "manual-link-reception-owner: recordChanges failed (non-fatal):",
          logErr,
        );
      }
    }

    try {
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
    } catch (logErr) {
      console.error(
        "manual-link-reception-owner: writeAuditLog failed (non-fatal):",
        logErr,
      );
    }

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
