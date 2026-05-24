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
  ROLLBACK_WINDOW_UPPER_TOLERANCE_MS,
  type ClassifiedRow,
  type FieldRestoreDecision,
  type JobWindow,
} from "@/lib/import-rollback";
import { extractUpdatedFields } from "@/lib/import-row-display";

interface BlockedDetail {
  rowNumber: number;
  action: "delete" | "restore";
  reason: string;
}

interface RestoreFieldDetail {
  /** P2 修正: 同 propertyId を指す複数 row がある場合の代表値 (rowNumbers の最小値) */
  rowNumber: number;
  /** P2 修正: 同 propertyId を指す全 row の rowNumber 配列（非 PII） */
  rowNumbers: number[];
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

    // Phase 2: 更新行は ChangeLog を per-field に評価して復元可能 field を決定。
    //
    // P1#2 修正: completedAt ±5s ではなく Job の実行期間 [startedAt(or createdAt), completedAt+小許容] で
    // ChangeLog を絞り込む。長時間 import で completedAt より大きく前に書かれた csv_import 行も拾えるように。
    // P1#1 修正: 後続更新は source を問わず一律ブロック（classifyUpdateFieldsForRestore 側で実装）。
    // changedBy も Job.executedBy で絞り込むことで別ジョブの csv_import 混入を最小化する。
    const jobWindow: JobWindow = {
      startMs: (job.startedAt ?? job.createdAt).getTime(),
      endMs:
        (job.completedAt ?? job.createdAt).getTime() +
        ROLLBACK_WINDOW_UPPER_TOLERANCE_MS,
      executedBy: job.executedBy,
    };
    const restoreTargetIds = restoreRows.map((c) => c.createdId!);
    // 候補は window 内 + executedBy 一致を優先的に取るが、後続更新検知 (P1#1) のために
    // 同 propertyId の全 ChangeLog を取得し、helper 側で window フィルタする。
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
              changedBy: true,
            },
          })
        : [];
    const logsByProperty = new Map<string, typeof changeLogs>();
    for (const log of changeLogs) {
      const arr = logsByProperty.get(log.targetId) ?? [];
      arr.push(log);
      logsByProperty.set(log.targetId, arr);
    }

    // P2 修正: 複数 row が同じ Property を指すケース（property_csv は updatable な
    // マッチキー (realEstateNumber / externalLinkKey / buildingId+roomNo 等) で
    // 同 Property に紐づき得る）を考慮し、propertyId 単位に集約してから復元判定する。
    interface RestorePlan {
      propertyId: string;
      rowNumbers: number[]; // 同 propertyId を指す全 row（非 PII の rowNumber のみ）
      decisions: FieldRestoreDecision[];
      restorableFields: FieldRestoreDecision[];
    }
    const rowsByProperty = new Map<string, ClassifiedRow[]>();
    for (const row of restoreRows) {
      const arr = rowsByProperty.get(row.createdId!) ?? [];
      arr.push(row);
      rowsByProperty.set(row.createdId!, arr);
    }

    // P1 round 4: rollback 対象 Job の ImportJobRow が「実際に更新した field」を
    // errorMessage の "更新項目: ..." から抽出して row-level evidence にする。
    // ChangeLog に importJobId がないため、別 Job 由来の csv_import が time window 内に
    // 紛れ込んだ場合に誤って restore してしまうのを防ぐ二段目のガード。
    const rowById = new Map(job.rows.map((r) => [r.id, r]));

    const restorePlans: RestorePlan[] = [];
    let restorableFieldCount = 0;

    for (const [propertyId, rowsForProp] of rowsByProperty) {
      const rowNumbers = rowsForProp
        .map((r) => r.rowNumber)
        .sort((a, b) => a - b);
      const representativeRowNumber = rowNumbers[0];

      const prop = propMap.get(propertyId);
      if (!prop) {
        blockedDetails.push({
          rowNumber: representativeRowNumber,
          action: "restore",
          reason: "物件が既に存在しません（既に削除済み）",
        });
        continue;
      }

      // P1 修正: Property.updatedAt による post-import guard。
      // ChangeLog だけでは検出できない更新（例: confirmInvestigationRecord が
      // prisma.property.update を直接呼ぶケース、bulk-update の一部経路など）が
      // import 完了後にあった場合、新しい値を古い値で上書きしてしまう事故を防ぐ。
      // delete 側 (Phase 1) と同じ閾値・許容で判定する。
      if (prop.updatedAt.getTime() > completedAtMs + TOLERANCE_MS) {
        blockedDetails.push({
          rowNumber: representativeRowNumber,
          action: "restore",
          reason:
            "取込後に Property が更新されているため復元しません (post_import_update_detected)",
        });
        continue;
      }

      // P1 round 4: rollback 対象 Job の row が更新したと証明できる field を union。
      // 同 propertyId に複数 row があっても fieldSet に統合される（重複は自動排除）。
      const allowedFieldsForProp = new Set<string>();
      for (const r of rowsForProp) {
        const fullRow = rowById.get(r.rowId);
        if (!fullRow) continue;
        for (const f of extractUpdatedFields(fullRow.errorMessage)) {
          allowedFieldsForProp.add(f);
        }
      }
      // evidence ゼロの場合は、この Property の restore 全体を安全側で block する。
      // (row が success+isUpdateMessage で classifyRowsForRollback に restore と判定されたが、
      //  errorMessage に "更新項目: ..." が無い等の理由で確証が取れないケース)
      if (allowedFieldsForProp.size === 0) {
        blockedDetails.push({
          rowNumber: representativeRowNumber,
          action: "restore",
          reason:
            "rollback対象ジョブがこのPropertyのフィールドを更新した証拠がありません (missing_row_field_evidence)",
        });
        continue;
      }

      const logs = logsByProperty.get(propertyId) ?? [];
      const decisions = classifyUpdateFieldsForRestore(
        logs,
        jobWindow,
        allowedFieldsForProp,
      );
      const restorableFields = decisions.filter(
        (d) => d.status === "restorable",
      );
      // 個別 field の skip 理由は blockedDetails に細かく出さず restoreDetails 側で per-property に表示。
      // ただし「全 field 復元不可」なら 1 件 blocked として出して件数を増やす。
      if (restorableFields.length === 0) {
        // ambiguous_changelog / subsequent_edit が混在している可能性を考慮し、
        // どの理由でブロックされたかを reason に集約（PII を含まない status 値のみ）。
        const blockedReasonCounts = decisions.reduce<Record<string, number>>(
          (acc, d) => {
            if (d.status === "restorable") return acc;
            acc[d.status] = (acc[d.status] ?? 0) + 1;
            return acc;
          },
          {},
        );
        const reasonParts = Object.entries(blockedReasonCounts).map(
          ([s, n]) => `${s}=${n}`,
        );
        blockedDetails.push({
          rowNumber: representativeRowNumber,
          action: "restore",
          reason:
            decisions.length === 0
              ? "復元できる変更ログがありません"
              : `復元可能なフィールドがありません (${reasonParts.join(", ")})`,
        });
        continue;
      }
      restorePlans.push({
        propertyId,
        rowNumbers,
        decisions,
        restorableFields,
      });
      restorableFieldCount += restorableFields.length;
    }

    const restoreDetails: RestoreFieldDetail[] = restorePlans.map((p) => ({
      rowNumber: p.rowNumbers[0],
      rowNumbers: p.rowNumbers,
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
      rowNumbers: number[];
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
        if (!currentValues) {
          // P2 (round 3) 修正: dryRun では存在していた Property が execute 時点で
          // 消えているケース（並行削除や直前の rollback 同時実行など）。
          // 実適用集計から外し、blockedDetails に property_missing_at_execute を追加して
          // summary.restorable と restoredPropertyCount が乖離しないようにする。
          blockedDetails.push({
            rowNumber: plan.rowNumbers[0],
            action: "restore",
            reason:
              "実行時点で物件が存在しないため復元しません (property_missing_at_execute)",
          });
          continue;
        }
        await tx.property.update({
          where: { id: plan.propertyId },
          data: restoreData,
        });
        restoredPropertyCount++;
        restoredFieldCount += plan.restorableFields.length;
        restoreRecordPayloads.push({
          propertyId: plan.propertyId,
          rowNumbers: plan.rowNumbers,
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
        // PII を含まないため propertyId / rowNumbers / fieldNames のみ含める。
        // old/new/current の値は一切入れない。P2 修正で propertyId 単位に集約済みのため
        // 同 propertyId が複数回出る重複カウントは発生しない。
        restoredFields: restoreRecordPayloads.map((p) => ({
          propertyId: p.propertyId,
          rowNumbers: p.rowNumbers,
          fieldNames: p.fieldNames,
        })),
        blocked: blockedDetails.length,
        skipped: skipCount,
      },
    });

    // P2 (round 3) 修正: execute 時の summary / restoreDetails は **実適用件数** ベース。
    // transaction 中に property_missing_at_execute で skip された plan は除外され、
    // summary.restorable と restoredPropertyCount が常に一致するようにする。
    // (dryRun の summary は事前計画ベースのまま — 上の return apiResponse で対応済み)
    const restoreDetailsApplied: RestoreFieldDetail[] = restoreRecordPayloads.map(
      (p) => ({
        rowNumber: p.rowNumbers[0],
        rowNumbers: p.rowNumbers,
        propertyId: p.propertyId,
        fieldNames: p.fieldNames,
      }),
    );
    return apiResponse({
      alreadyRolledBack: false,
      eligible: true,
      summary: {
        deletable: deletable.length,
        restorable: restoredPropertyCount,
        restorableFieldCount: restoredFieldCount,
        blocked: blockedDetails.length,
        skipped: skipCount,
      },
      blockedDetails,
      restoreDetails: restoreDetailsApplied,
      executed: true,
      deletedCount,
      restoredPropertyCount,
      restoredFieldCount,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
