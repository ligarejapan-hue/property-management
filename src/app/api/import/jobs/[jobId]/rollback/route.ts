import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
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
  type ClassifiedRow,
} from "@/lib/import-rollback";

interface BlockedDetail {
  rowNumber: number;
  action: "delete" | "restore";
  reason: string;
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

    // Phase 1: 更新行のロールバック復元は未対応（型変換複雑のため安全側に止める）
    for (const row of restoreRows) {
      blockedDetails.push({
        rowNumber: row.rowNumber,
        action: "restore",
        reason: "更新行のロールバック復元は現在未対応です",
      });
    }

    if (dryRun) {
      return apiResponse({
        alreadyRolledBack: false,
        eligible: true,
        summary: {
          deletable: deletable.length,
          restorable: 0,
          blocked: blockedDetails.length,
          skipped: skipCount,
        },
        blockedDetails,
        executed: false,
      });
    }

    let deletedCount = 0;
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
      await tx.importJob.update({
        where: { id: job.id },
        data: { status: "rolled_back" },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "import_job_rollback",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        jobType: job.jobType,
        deletedCount,
        blocked: blockedDetails.length,
        skipped: skipCount,
      },
    });

    return apiResponse({
      alreadyRolledBack: false,
      eligible: true,
      summary: {
        deletable: deletable.length,
        restorable: 0,
        blocked: blockedDetails.length,
        skipped: skipCount,
      },
      blockedDetails,
      executed: true,
      deletedCount,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
