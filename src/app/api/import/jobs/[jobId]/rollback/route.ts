import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  classifyRowsForRollback,
  classifyUpdateFieldsForRestore,
  type ClassifiedRow,
  type FieldRestoreDecision,
} from "@/lib/import-rollback";

interface BlockedDetail {
  rowNumber: number;
  action: "delete" | "restore";
  reason: string;
}

interface RestoreFieldDetail {
  rowNumber: number;
  propertyId: string;
  fieldNames: string[];
}

const TOLERANCE_MS = 5000;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await ctx.params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
    const dryRun = body.dryRun !== false;

    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      include: { rows: { orderBy: { rowNumber: "asc" } } },
    });
    if (!job) throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");

    const baseSummary = { deletable: 0, restorable: 0, blocked: 0, skipped: 0 };

    if (job.status === "rolled_back") {
      return apiResponse({
        alreadyRolledBack: true,
        eligible: false,
        ineligibleReason: "このジョブは既にロールバック済みです",
        summary: baseSummary,
        blockedDetails: [],
        executed: false,
      });
    }
    if (job.jobType !== "property_csv") {
      return apiResponse({
        alreadyRolledBack: false,
        eligible: false,
        ineligibleReason: "現在ロールバック対応は物件CSVのみです",
        summary: baseSummary,
        blockedDetails: [],
        executed: false,
      });
    }
    if (job.status !== "completed") {
      return apiResponse({
        alreadyRolledBack: false,
        eligible: false,
        ineligibleReason: `ジョブが完了状態ではないため不可 (status=${job.status})`,
        summary: baseSummary,
        blockedDetails: [],
        executed: false,
      });
    }

    const completedAtMs = (job.completedAt ?? job.createdAt).getTime();

    const categorized = classifyRowsForRollback(job.rows);
    const deleteRows = categorized.filter((c) => c.category === "delete");
    const restoreRows = categorized.filter((c) => c.category === "restore");
    const skipCount = categorized.filter((c) => c.category === "skip").length;

    const targetIds = [
      ...deleteRows.map((c) => c.createdId!),
      ...restoreRows.map((c) => c.createdId!),
    ];
    const properties =
      targetIds.length > 0
        ? await prisma.property.findMany({
            where: { id: { in: targetIds } },
            select: {
              id: true,
              updatedAt: true,
              _count: {
                select: {
                  photos: true,
                  attachments: true,
                  propertyOwners: true,
                  comments: true,
                  nextActions: true,
                  dmLogs: true,
                  investigationLogs: true,
                },
              },
            },
          })
        : [];
    const propMap = new Map(properties.map((p) => [p.id, p]));

    const blockedDetails: BlockedDetail[] = [];
    const deletable: ClassifiedRow[] = [];

    for (const row of deleteRows) {
      const prop = propMap.get(row.createdId!);
      if (!prop) {
        blockedDetails.push({
          rowNumber: row.rowNumber,
          action: "delete",
          reason: "物件が既に存在しません（既に削除済み）",
        });
        continue;
      }
      const c = prop._count;
      const hasRelated =
        c.photos > 0 ||
        c.attachments > 0 ||
        c.propertyOwners > 0 ||
        c.comments > 0 ||
        c.nextActions > 0 ||
        c.dmLogs > 0 ||
        c.investigationLogs > 0;
      if (hasRelated) {
        blockedDetails.push({
          rowNumber: row.rowNumber,
          action: "delete",
          reason: "子データ(写真/添付/所有者など)があるため削除できません",
        });
        continue;
      }
      if (prop.updatedAt.getTime() > completedAtMs + TOLERANCE_MS) {
        blockedDetails.push({
          rowNumber: row.rowNumber,
          action: "delete",
          reason: "取込後に更新されているため削除できません",
        });
        continue;
      }
      deletable.push(row);
    }

    // Phase 2: 更新行は ChangeLog を per-field に評価して復元可能 field を決定
    const restoreTargetIds = restoreRows.map((c) => c.createdId!);
    const changeLogs =
      restoreTargetIds.length > 0
        ? await prisma.changeLog.findMany({
            where: {
              targetTable: "properties",
              targetId: { in: restoreTargetIds },
            },
            select: {
              targetId: true,
              fieldName: true,
              oldValue: true,
              newValue: true,
              source: true,
              changedAt: true,
            },
          })
        : [];
    const logsByProperty = new Map<string, typeof changeLogs>();
    for (const log of changeLogs) {
      const arr = logsByProperty.get(log.targetId) ?? [];
      arr.push(log);
      logsByProperty.set(log.targetId, arr);
    }

    interface RestorePlan {
      row: ClassifiedRow;
      propertyId: string;
      decisions: FieldRestoreDecision[];
      restorableFields: FieldRestoreDecision[];
    }
    const restorePlans: RestorePlan[] = [];
    let restorableFieldCount = 0;

    for (const row of restoreRows) {
      const propertyId = row.createdId!;
      const prop = propMap.get(propertyId);
      if (!prop) {
        blockedDetails.push({
          rowNumber: row.rowNumber,
          action: "restore",
          reason: "物件が既に存在しません（既に削除済み）",
        });
        continue;
      }
      const logs = logsByProperty.get(propertyId) ?? [];
      const decisions = classifyUpdateFieldsForRestore(logs, completedAtMs);
      const restorableFields = decisions.filter(
        (d) => d.status === "restorable",
      );
      // 個別 field の skip 理由は blockedDetails に細かく出さず restoreDetails 側で per-property に表示。
      // ただし「全 field 復元不可」なら 1 件 blocked として出して件数を増やす。
      if (restorableFields.length === 0) {
        blockedDetails.push({
          rowNumber: row.rowNumber,
          action: "restore",
          reason:
            decisions.length === 0
              ? "復元できる変更ログがありません"
              : "復元可能なフィールドがありません",
        });
        continue;
      }
      restorePlans.push({ row, propertyId, decisions, restorableFields });
      restorableFieldCount += restorableFields.length;
    }

    const restoreDetails: RestoreFieldDetail[] = restorePlans.map((p) => ({
      rowNumber: p.row.rowNumber,
      propertyId: p.propertyId,
      fieldNames: p.restorableFields.map((d) => d.fieldName),
    }));

    if (dryRun) {
      return apiResponse({
        alreadyRolledBack: false,
        eligible: true,
        summary: {
          deletable: deletable.length,
          restorable: restorePlans.length,
          restorableFieldCount,
          blocked: blockedDetails.length,
          skipped: skipCount,
        },
        blockedDetails,
        restoreDetails,
        executed: false,
      });
    }

    let deletedCount = 0;
    let restoredPropertyCount = 0;
    let restoredFieldCount = 0;
    // recordChanges を tx 外でまとめて呼ぶための退避（recordChanges は prisma 直接利用のため）
    const restoreRecordPayloads: Array<{
      propertyId: string;
      oldValues: Record<string, unknown>;
      newValues: Record<string, unknown>;
      fieldNames: string[];
    }> = [];

    await prisma.$transaction(async (tx) => {
      // 二重実行防止：トランザクション内で再度 status を確認
      const fresh = await tx.importJob.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      if (!fresh || fresh.status !== "completed") {
        throw new ApiError(
          409,
          "ジョブの状態が変わったためロールバックを中断しました",
          "CONFLICT",
        );
      }
      for (const row of deletable) {
        await tx.property.delete({ where: { id: row.createdId! } });
        deletedCount++;
      }
      for (const plan of restorePlans) {
        const restoreData: Record<string, unknown> = {};
        for (const d of plan.restorableFields) {
          restoreData[d.fieldName] = d.restoreValue;
        }
        // 現在値（後続編集なしを classify で保証済みのため csv_import 前の値とは別の新規値）
        // を ChangeLog 用に取得する。restoreData を newValues、現在値を oldValues として
        // recordChanges に渡すと "復元前 → 復元後" の正しい diff になる。
        const currentValues = await tx.property.findUnique({
          where: { id: plan.propertyId },
          select: plan.restorableFields.reduce<Record<string, true>>(
            (acc, d) => {
              acc[d.fieldName] = true;
              return acc;
            },
            {},
          ),
        });
        if (!currentValues) continue;
        await tx.property.update({
          where: { id: plan.propertyId },
          data: restoreData,
        });
        restoredPropertyCount++;
        restoredFieldCount += plan.restorableFields.length;
        restoreRecordPayloads.push({
          propertyId: plan.propertyId,
          oldValues: currentValues as Record<string, unknown>,
          newValues: restoreData,
          fieldNames: plan.restorableFields.map((d) => d.fieldName),
        });
      }
      await tx.importJob.update({
        where: { id: job.id },
        data: { status: "rolled_back" },
      });
    });

    // ChangeLog: 復元自体も Property の変更として、source=api で記録（rollback 実行者の API 操作）
    for (const payload of restoreRecordPayloads) {
      await recordChanges({
        targetTable: "properties",
        targetId: payload.propertyId,
        changedBy: session.id,
        oldValues: payload.oldValues,
        newValues: payload.newValues,
        trackedFields: payload.fieldNames,
        source: "api",
      });
    }

    await writeAuditLog({
      userId: session.id,
      action: "import_job_rollback",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        jobType: job.jobType,
        deletedCount,
        restoredPropertyCount,
        restoredFieldCount,
        // PII を含まないため propertyId / rowNumber / fieldNames のみ含める。
        // old/new/current の値は一切入れない。
        restoredFields: restoreRecordPayloads.map((p) => ({
          propertyId: p.propertyId,
          fieldNames: p.fieldNames,
        })),
        blocked: blockedDetails.length,
        skipped: skipCount,
      },
    });

    return apiResponse({
      alreadyRolledBack: false,
      eligible: true,
      summary: {
        deletable: deletable.length,
        restorable: restorePlans.length,
        restorableFieldCount,
        blocked: blockedDetails.length,
        skipped: skipCount,
      },
      blockedDetails,
      restoreDetails,
      executed: true,
      deletedCount,
      restoredPropertyCount,
      restoredFieldCount,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
