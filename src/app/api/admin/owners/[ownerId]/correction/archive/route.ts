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
import {
  checkOwnerArchiveSafety,
  type OwnerArchiveBlockReason,
} from "@/lib/owner-correction";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:ownerId/correction/archive
// ---------------------------------------------------------------------------
// Phase 2-A: orphan owner の soft-delete（isArchived=true）。
//
// 権限:
//   - dryRun: user_management:read + owner:read（correction candidates 閲覧と同等）
//   - 実行 (dryRun=false): 上記に加えて owner:delete
//
// Request body:
//   { version: number, dryRun?: boolean }
//   dryRun の default は true。dryRun=false を明示したときのみ DB を更新する。
//
// レスポンス（PII は含めない・blockReasons は enum のみ）:
//   dryRun=true:
//     200 { executed: false, eligible: boolean, blockReasons: enum[] }
//   dryRun=false 成功:
//     200 { executed: true, id, version, updatedFields: ["isArchived"] }
//   404 owner 不存在 / 既に isArchived=true
//   403 権限不足
//   409 version_mismatch（実行時のみ）
//   422 その他 safety 違反（実行時のみ。blockReasons enum を返す）
//
// 安全条件は checkOwnerArchiveSafety と同じ:
//   - PropertyOwner.count === 0
//   - ChangeLog なし / version === 1（→ not_delete_candidate）
//   - note 空 / externalLinkKey 空
//   - owner_csv ImportJobRow が 1件かつ status=success
//
// 実行パスでは transaction 内で再評価する（candidate API 時点と乖離する可能性に対処）。
// AuditLog / ChangeLog は dryRun=false の成功時のみ書き込む。
// ---------------------------------------------------------------------------

async function loadOwnerArchiveState(ownerId: string) {
  const owner = await prisma.owner.findUnique({
    where: { id: ownerId },
    select: {
      id: true,
      version: true,
      isArchived: true,
      note: true,
      externalLinkKey: true,
      _count: { select: { propertyOwners: true } },
    },
  });
  if (!owner) return null;

  const changeLogCount = await prisma.changeLog.count({
    where: { targetTable: "owners", targetId: ownerId },
  });

  const importRows = await prisma.importJobRow.findMany({
    where: { createdId: ownerId, job: { jobType: "owner_csv" } },
    select: { id: true, status: true },
  });

  return {
    owner,
    changeLogCount,
    importRowCount: importRows.length,
    importRowSuccess:
      importRows.length === 1 && importRows[0].status === "success",
  };
}

function statusFromReasons(reasons: OwnerArchiveBlockReason[]): number {
  // PropertyOwner が存在する場合は linked-owner 隠蔽リスクの方が重要なので
  // version_mismatch より優先して 422 を返す。
  if (reasons.includes("property_owner_exists")) return 422;
  if (reasons.includes("version_mismatch")) return 409;
  return 422;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ownerId: string }> },
) {
  try {
    const { ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 共通権限: 管理エリア + owner 閲覧
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const body = await request.json().catch(() => ({}));
    const version = body?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "version は正の整数で指定してください", "INVALID_INPUT");
    }
    const dryRun = body?.dryRun !== false; // default: true

    // 実行時のみ owner:delete を必須
    if (!dryRun && !hasPermission(perms, "owner", "delete")) {
      throw new ApiError(403, "所有者削除の権限がありません", "FORBIDDEN");
    }

    // 状態取得
    const state = await loadOwnerArchiveState(ownerId);
    if (!state) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }
    if (state.owner.isArchived) {
      throw new ApiError(404, "所有者は既にアーカイブ済みです", "NOT_FOUND");
    }

    const safety = checkOwnerArchiveSafety({
      isArchived: state.owner.isArchived,
      versionMatches: state.owner.version === version,
      propertyOwnerCount: state.owner._count.propertyOwners,
      changeLogCount: state.changeLogCount,
      hasNote: !!state.owner.note && state.owner.note.trim().length > 0,
      hasExternalLinkKey:
        !!state.owner.externalLinkKey &&
        state.owner.externalLinkKey.trim().length > 0,
      version: state.owner.version,
      importRowCount: state.importRowCount,
      importRowSuccess: state.importRowSuccess,
    });

    // ── dryRun: DB 変更も AuditLog も書かない ───────────────────────────────
    if (dryRun) {
      return apiResponse({
        executed: false,
        eligible: safety.ok,
        blockReasons: safety.ok ? [] : safety.reasons,
      });
    }

    // ── 実行: dryRun=false ─────────────────────────────────────────────────
    if (!safety.ok) {
      // ApiError は detail を持たないため、blockReasons を含むエラーは直接返す。
      return apiResponse(
        {
          error: {
            message: "アーカイブ条件を満たしていません",
            code: "ARCHIVE_BLOCKED",
            blockReasons: safety.reasons,
          },
        },
        statusFromReasons(safety.reasons),
      );
    }

    // transaction 内で再評価 + 更新。
    // updateMany の where に isArchived=false / version を含め、競合と二重実行を防ぐ。
    // tx 内で発生した safety 違反は sentinel エラーで巻き戻し、blockReasons を外で返す。
    const newVersion = version + 1;
    const TX_BLOCKED_SENTINEL = "__archive_blocked_in_tx__";
    let txBlockedReasons: OwnerArchiveBlockReason[] | null = null;
    let txNotFound = false;
    try {
      await prisma.$transaction(async (tx) => {
        const recheck = await tx.owner.findUnique({
          where: { id: ownerId },
          select: {
            version: true,
            isArchived: true,
            note: true,
            externalLinkKey: true,
            _count: { select: { propertyOwners: true } },
          },
        });
        if (!recheck || recheck.isArchived) {
          txNotFound = true;
          throw new Error(TX_BLOCKED_SENTINEL);
        }
        const [recheckChangeLogCount, recheckImportRows] = await Promise.all([
          tx.changeLog.count({
            where: { targetTable: "owners", targetId: ownerId },
          }),
          tx.importJobRow.findMany({
            where: { createdId: ownerId, job: { jobType: "owner_csv" } },
            select: { status: true },
          }),
        ]);
        const recheckSafety = checkOwnerArchiveSafety({
          isArchived: recheck.isArchived,
          versionMatches: recheck.version === version,
          propertyOwnerCount: recheck._count.propertyOwners,
          changeLogCount: recheckChangeLogCount,
          hasNote: !!recheck.note && recheck.note.trim().length > 0,
          hasExternalLinkKey:
            !!recheck.externalLinkKey &&
            recheck.externalLinkKey.trim().length > 0,
          version: recheck.version,
          importRowCount: recheckImportRows.length,
          importRowSuccess:
            recheckImportRows.length === 1 &&
            recheckImportRows[0].status === "success",
        });
        if (!recheckSafety.ok) {
          txBlockedReasons = recheckSafety.reasons;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 最終 updateMany の where に propertyOwners none を含める。
        // safety check 後〜updateMany 前に PropertyOwner が作成された場合でも、
        // archive を絶対に成立させない（linked owner を隠さない）。
        // count=0 になった場合は、現在状態を再読込して reason を分類する。
        const result = await tx.owner.updateMany({
          where: {
            id: ownerId,
            version,
            isArchived: false,
            propertyOwners: { none: {} },
          },
          data: { isArchived: true, version: { increment: 1 } },
        });
        if (result.count === 0) {
          // 何が変わって失敗したかを PII なしで確認する
          const cur = await tx.owner.findUnique({
            where: { id: ownerId },
            select: {
              version: true,
              isArchived: true,
              _count: { select: { propertyOwners: true } },
            },
          });
          const reasons: OwnerArchiveBlockReason[] = [];
          if (!cur || cur.isArchived) {
            reasons.push("owner_archived");
          }
          if (cur && cur.version !== version) {
            reasons.push("version_mismatch");
          }
          if (cur && cur._count.propertyOwners > 0) {
            reasons.push("property_owner_exists");
          }
          if (reasons.length === 0) {
            // owner 行は存在し isArchived=false version 一致 PropertyOwner 0 なのに
            // 更新できなかった稀少ケース。安全側で version_mismatch として返す。
            reasons.push("version_mismatch");
          }
          txBlockedReasons = reasons;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        await tx.changeLog.createMany({
          data: [
            {
              targetTable: "owners",
              targetId: ownerId,
              fieldName: "isArchived",
              oldValue: "false",
              newValue: "true",
              source: "manual",
              changedBy: session.id,
            },
          ],
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === TX_BLOCKED_SENTINEL) {
        if (txNotFound) {
          throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
        }
        const reasons = txBlockedReasons ?? [];
        return apiResponse(
          {
            error: {
              message: "アーカイブ条件を満たしていません",
              code: "ARCHIVE_BLOCKED",
              blockReasons: reasons,
            },
          },
          statusFromReasons(reasons),
        );
      }
      throw e;
    }

    // AuditLog（transaction 外・PII なし）
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_archive",
      targetTable: "owners",
      targetId: ownerId,
      detail: {
        correctionType: "archive",
        dryRun: false,
        updatedFields: ["isArchived"],
      },
    });

    return apiResponse({
      executed: true,
      id: ownerId,
      version: newVersion,
      updatedFields: ["isArchived"],
    });
  } catch (error) {
    return handleApiError(error);
  }
}
