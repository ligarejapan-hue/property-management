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
  checkOwnerMislinkSafety,
  type OwnerMislinkBlockReason,
  type OwnerMislinkOperation,
} from "@/lib/owner-mislink";
import { canAccessPropertyRecord } from "@/lib/property-access";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/correction/mislink
// ---------------------------------------------------------------------------
// Phase 2-C: PropertyOwner 誤紐づき修正の execute。
//
// 権限:
//   - dryRun=true / dryRun=false の両方とも:
//     user_management:read + owner:read + owner:write + property:read + property:write
//   - owner:delete は不要（owner 自体は削除しない、merge execute との明確な区別）
//   - property record-scope: canAccessPropertyRecord (field_staff)
//
// Request body:
//   {
//     operation: "remove" | "relink",
//     propertyId, propertyOwnerId, currentOwnerId, targetOwnerId?,
//     currentOwnerVersion, targetOwnerVersion?, propertyVersion,
//     dryRun: default true
//   }
//
// レスポンス（PII を含まない・enum / ID / version / 件数 / boolean）:
//   dryRun=true:
//     200 { executed: false, eligible, blockReasons[], summary }
//   dryRun=false 成功:
//     200 {
//       executed: true,
//       operation,
//       propertyId, propertyOwnerId,
//       result: {
//         removed: boolean,
//         previousOwnerId,
//         newOwnerId: string | null,
//         currentOwnerVersion (new),
//         targetOwnerVersion (new | null),
//         propertyVersion (new)
//       }
//     }
//   400 UUID/version/operation 不正
//   403 権限不足
//   404 対象不存在
//   409 version_mismatch
//   422 same_owner_id / その他 safety 違反
//
// transaction 設計:
//   1. owner row を id sort 順で lock。
//      currentOwner は isArchived=false 条件にせず、updatedAt touch + version 確認のみ
//      （archived な source も remove / relink ソースとしては許可）。
//      targetOwner は { id, version, isArchived: false } で lock。archived target は blocker。
//   2. property を { id, version, isArchived: false } で lock + version 確認。
//   3. tx 内で PropertyOwner を再取得し、propertyId / ownerId 一致確認。
//   4. operation === "relink" の場合、target が同 property に既に紐付いていないか
//      tx 内で findUnique で再確認。
//   5. 操作実行:
//      - remove: PropertyOwner.delete + currentOwner.version++ + property.version++
//      - relink: PropertyOwner.update(ownerId = target)
//                + currentOwner.version++ + targetOwner.version++ + property.version++
//   6. ChangeLog batch:
//      - remove: `_deleted_via_mislink_correction`
//      - relink: `ownerId` 変更 + `_relinked_via_mislink_correction`
//   7. AuditLog (tx 外): owner_correction_mislink、PII フリー。
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  operation?: unknown;
  propertyId?: unknown;
  propertyOwnerId?: unknown;
  currentOwnerId?: unknown;
  targetOwnerId?: unknown;
  currentOwnerVersion?: unknown;
  targetOwnerVersion?: unknown;
  propertyVersion?: unknown;
  dryRun?: unknown;
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_REGEX.test(v);
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function statusFromReasons(reasons: OwnerMislinkBlockReason[]): number {
  if (reasons.includes("version_mismatch")) return 409;
  return 422;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者更新の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件更新の権限がありません", "FORBIDDEN");
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const operation = body.operation;
    const propertyId = body.propertyId;
    const propertyOwnerId = body.propertyOwnerId;
    const currentOwnerId = body.currentOwnerId;
    const targetOwnerIdRaw = body.targetOwnerId;
    const currentOwnerVersion = body.currentOwnerVersion;
    const targetOwnerVersionRaw = body.targetOwnerVersion;
    const propertyVersion = body.propertyVersion;
    const dryRun = body.dryRun !== false;

    if (operation !== "remove" && operation !== "relink") {
      throw new ApiError(
        400,
        "operation は 'remove' または 'relink' を指定してください",
        "INVALID_INPUT",
      );
    }
    if (
      !isUuid(propertyId) ||
      !isUuid(propertyOwnerId) ||
      !isUuid(currentOwnerId)
    ) {
      throw new ApiError(
        400,
        "propertyId / propertyOwnerId / currentOwnerId は UUID 形式で指定してください",
        "INVALID_INPUT",
      );
    }
    if (!isPosInt(currentOwnerVersion) || !isPosInt(propertyVersion)) {
      throw new ApiError(
        400,
        "currentOwnerVersion / propertyVersion は正の整数で指定してください",
        "INVALID_INPUT",
      );
    }

    const op = operation as OwnerMislinkOperation;
    const hasTarget =
      op === "relink" &&
      targetOwnerIdRaw !== null &&
      targetOwnerIdRaw !== undefined &&
      targetOwnerIdRaw !== "";
    if (op === "relink" && hasTarget && !isUuid(targetOwnerIdRaw)) {
      throw new ApiError(
        400,
        "targetOwnerId は UUID 形式で指定してください",
        "INVALID_INPUT",
      );
    }
    const targetOwnerId =
      op === "relink" && hasTarget ? (targetOwnerIdRaw as string) : null;
    if (op === "relink" && targetOwnerId !== null) {
      if (!isPosInt(targetOwnerVersionRaw)) {
        throw new ApiError(
          400,
          "targetOwnerVersion は正の整数で指定してください",
          "INVALID_INPUT",
        );
      }
    }
    const targetOwnerVersion =
      op === "relink" && targetOwnerId !== null
        ? (targetOwnerVersionRaw as number)
        : null;

    // same_owner_id 422 早期
    if (op === "relink" && targetOwnerId === currentOwnerId) {
      return apiResponse(
        {
          error: {
            message: "current と target に同じ所有者を指定できません",
            code: "MISLINK_BLOCKED",
            blockReasons: ["same_owner_id"] satisfies OwnerMislinkBlockReason[],
          },
        },
        422,
      );
    }

    const [propertyOwner, property, currentOwner, targetOwner] =
      await Promise.all([
        prisma.propertyOwner.findUnique({
          where: { id: propertyOwnerId },
          select: { id: true, propertyId: true, ownerId: true },
        }),
        prisma.property.findUnique({
          where: { id: propertyId },
          select: {
            id: true,
            version: true,
            isArchived: true,
            createdBy: true,
            assignedTo: true,
          },
        }),
        prisma.owner.findUnique({
          where: { id: currentOwnerId },
          select: { id: true, version: true, isArchived: true },
        }),
        targetOwnerId
          ? prisma.owner.findUnique({
              where: { id: targetOwnerId },
              select: { id: true, version: true, isArchived: true },
            })
          : Promise.resolve(null),
      ]);

    if (!propertyOwner && !property && !currentOwner) {
      throw new ApiError(404, "対象が見つかりません", "NOT_FOUND");
    }

    if (property && !canAccessPropertyRecord(session, property)) {
      throw new ApiError(
        403,
        "この物件を閲覧する権限がありません",
        "FORBIDDEN",
      );
    }

    // target が同 property に既に紐付き?
    let targetAlreadyLinked = false;
    if (op === "relink" && targetOwnerId && property) {
      const existing = await prisma.propertyOwner.findUnique({
        where: {
          propertyId_ownerId: {
            propertyId: property.id,
            ownerId: targetOwnerId,
          },
        },
        select: { id: true },
      });
      targetAlreadyLinked = existing !== null;
    }

    const ownerMemoCountOnThisProperty = currentOwner
      ? await prisma.ownerMemo.count({
          where: { ownerId: currentOwner.id, propertyId },
        })
      : 0;

    const safety = checkOwnerMislinkSafety({
      operation: op,
      hasTargetForRelink: op === "relink" ? hasTarget : true,
      sameOwnerId: op === "relink" && targetOwnerId === currentOwnerId,
      propertyOwnerExists: propertyOwner !== null,
      propertyOwnerPropertyIdMatches:
        propertyOwner !== null && propertyOwner.propertyId === propertyId,
      propertyOwnerOwnerIdMatches:
        propertyOwner !== null && propertyOwner.ownerId === currentOwnerId,
      propertyExists: property !== null,
      propertyIsArchived: property?.isArchived ?? false,
      propertyVersionMatches:
        property !== null && property.version === propertyVersion,
      currentOwnerExists: currentOwner !== null,
      currentOwnerVersionMatches:
        currentOwner !== null && currentOwner.version === currentOwnerVersion,
      targetOwnerExists: targetOwner !== null,
      targetOwnerIsArchived: targetOwner?.isArchived ?? false,
      targetOwnerVersionMatches:
        targetOwner === null ||
        (targetOwnerVersion !== null &&
          targetOwner.version === targetOwnerVersion),
      targetAlreadyLinked,
    });

    const summary = {
      currentOwnerId,
      currentOwnerArchived: currentOwner?.isArchived ?? false,
      targetOwnerId,
      targetOwnerArchived: targetOwner?.isArchived ?? false,
      targetAlreadyLinked,
      propertyArchived: property?.isArchived ?? false,
      ownerMemoCountOnThisProperty,
      currentOwnerVersion: currentOwner?.version ?? null,
      targetOwnerVersion: targetOwner?.version ?? null,
      propertyVersion: property?.version ?? null,
    };

    const eligible = safety.ok;
    const blockReasons = safety.ok ? [] : safety.reasons;

    if (dryRun) {
      return apiResponse({
        executed: false,
        eligible,
        blockReasons,
        propertyId,
        propertyOwnerId,
        operation: op,
        summary,
      });
    }

    if (!eligible) {
      return apiResponse(
        {
          error: {
            message: "誤紐づき修正条件を満たしていません",
            code: "MISLINK_BLOCKED",
            blockReasons,
          },
        },
        statusFromReasons(blockReasons),
      );
    }

    // 必ず eligible=true なら property/propertyOwner/currentOwner は存在
    if (!propertyOwner || !property || !currentOwner) {
      throw new ApiError(404, "対象が見つかりません", "NOT_FOUND");
    }

    const TX_BLOCKED_SENTINEL = "__mislink_blocked_in_tx__";
    let txBlockedReasons: OwnerMislinkBlockReason[] | null = null;
    let txNotFound = false;
    const newCurrentOwnerVersion = currentOwnerVersion + 1;
    const newTargetOwnerVersion =
      targetOwnerVersion !== null ? targetOwnerVersion + 1 : null;
    const newPropertyVersion = propertyVersion + 1;

    try {
      await prisma.$transaction(async (tx) => {
        // 1. owner row を id sort 順で lock。
        //    currentOwner: archived でも source として許可するため
        //                  WHERE に isArchived:false は含めない。version のみ確認。
        //    targetOwner: archived は blocker のため WHERE に isArchived:false 含む。
        const lockSpecs: Array<{
          id: string;
          version: number;
          requireActive: boolean;
        }> = [
          {
            id: currentOwner.id,
            version: currentOwnerVersion,
            requireActive: false,
          },
        ];
        if (op === "relink" && targetOwner && targetOwnerVersion !== null) {
          lockSpecs.push({
            id: targetOwner.id,
            version: targetOwnerVersion,
            requireActive: true,
          });
        }
        lockSpecs.sort((a, b) => a.id.localeCompare(b.id));

        for (const spec of lockSpecs) {
          const where: Record<string, unknown> = {
            id: spec.id,
            version: spec.version,
          };
          if (spec.requireActive) where.isArchived = false;
          const lockResult = await tx.owner.updateMany({
            where,
            data: { updatedAt: new Date() },
          });
          if (lockResult.count === 0) {
            // version mismatch / archived target / 不存在 を区別するため
            // 再読込で reason を分類
            const cur = await tx.owner.findUnique({
              where: { id: spec.id },
              select: { id: true, version: true, isArchived: true },
            });
            if (!cur) {
              if (spec.id === currentOwner.id) {
                txBlockedReasons = ["current_owner_not_found"];
              } else {
                txBlockedReasons = ["target_owner_not_found"];
              }
            } else if (spec.requireActive && cur.isArchived) {
              txBlockedReasons = ["target_owner_archived"];
            } else {
              txBlockedReasons = ["version_mismatch"];
            }
            throw new Error(TX_BLOCKED_SENTINEL);
          }
        }

        // 2. property を lock + version 確認
        const propLock = await tx.property.updateMany({
          where: {
            id: property.id,
            version: propertyVersion,
            isArchived: false,
          },
          data: { updatedAt: new Date() },
        });
        if (propLock.count === 0) {
          const cur = await tx.property.findUnique({
            where: { id: property.id },
            select: { id: true, version: true, isArchived: true },
          });
          if (!cur) {
            txBlockedReasons = ["property_not_found"];
          } else if (cur.isArchived) {
            txBlockedReasons = ["property_archived"];
          } else {
            txBlockedReasons = ["version_mismatch"];
          }
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 3. PropertyOwner 再取得（並行 race で削除されていたケースを検出）
        const freshPO = await tx.propertyOwner.findUnique({
          where: { id: propertyOwnerId },
          select: { id: true, propertyId: true, ownerId: true },
        });
        if (!freshPO) {
          txBlockedReasons = ["property_owner_not_found"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }
        if (freshPO.propertyId !== propertyId) {
          txBlockedReasons = ["property_owner_state_mismatch"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }
        if (freshPO.ownerId !== currentOwnerId) {
          txBlockedReasons = ["current_owner_id_mismatch"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 4. relink の場合、target が同 property に既に紐付いていないか再確認
        if (op === "relink" && targetOwnerId) {
          const conflict = await tx.propertyOwner.findUnique({
            where: {
              propertyId_ownerId: {
                propertyId: property.id,
                ownerId: targetOwnerId,
              },
            },
            select: { id: true },
          });
          if (conflict) {
            txBlockedReasons = ["target_already_linked"];
            throw new Error(TX_BLOCKED_SENTINEL);
          }
        }

        // 5. 操作実行
        if (op === "remove") {
          await tx.propertyOwner.delete({
            where: { id: propertyOwnerId },
          });
        } else {
          if (!targetOwnerId) {
            // ガード（型上は来ないはず）
            txBlockedReasons = ["missing_target_for_relink"];
            throw new Error(TX_BLOCKED_SENTINEL);
          }
          await tx.propertyOwner.update({
            where: { id: propertyOwnerId },
            data: { ownerId: targetOwnerId },
          });
        }

        // 6. owner / property の version bump
        const curBump = await tx.owner.updateMany({
          where: {
            id: currentOwner.id,
            version: currentOwnerVersion,
          },
          data: { version: { increment: 1 } },
        });
        if (curBump.count === 0) {
          txBlockedReasons = ["version_mismatch"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        if (op === "relink" && targetOwner && targetOwnerVersion !== null) {
          const tgtBump = await tx.owner.updateMany({
            where: {
              id: targetOwner.id,
              version: targetOwnerVersion,
              isArchived: false,
            },
            data: { version: { increment: 1 } },
          });
          if (tgtBump.count === 0) {
            txBlockedReasons = ["version_mismatch"];
            throw new Error(TX_BLOCKED_SENTINEL);
          }
        }

        const propBump = await tx.property.updateMany({
          where: {
            id: property.id,
            version: propertyVersion,
            isArchived: false,
          },
          data: { version: { increment: 1 } },
        });
        if (propBump.count === 0) {
          txBlockedReasons = ["version_mismatch"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 7. ChangeLog batch (PII を含まない ID / 合成 fieldName のみ)
        const changeLogs: Array<{
          targetTable: string;
          targetId: string;
          fieldName: string;
          oldValue: string | null;
          newValue: string | null;
          source: "manual";
          changedBy: string;
        }> = [];

        if (op === "remove") {
          changeLogs.push({
            targetTable: "property_owners",
            targetId: propertyOwnerId,
            fieldName: "_deleted_via_mislink_correction",
            oldValue: currentOwnerId,
            newValue: null,
            source: "manual",
            changedBy: session.id,
          });
        } else if (targetOwnerId) {
          changeLogs.push({
            targetTable: "property_owners",
            targetId: propertyOwnerId,
            fieldName: "ownerId",
            oldValue: currentOwnerId,
            newValue: targetOwnerId,
            source: "manual",
            changedBy: session.id,
          });
          changeLogs.push({
            targetTable: "property_owners",
            targetId: propertyOwnerId,
            fieldName: "_relinked_via_mislink_correction",
            oldValue: currentOwnerId,
            newValue: targetOwnerId,
            source: "manual",
            changedBy: session.id,
          });
        }

        if (changeLogs.length > 0) {
          await tx.changeLog.createMany({ data: changeLogs });
        }
      });
    } catch (e) {
      if (e instanceof Error && e.message === TX_BLOCKED_SENTINEL) {
        if (txNotFound) {
          throw new ApiError(404, "対象が見つかりません", "NOT_FOUND");
        }
        const reasons = txBlockedReasons ?? [];
        return apiResponse(
          {
            error: {
              message: "誤紐づき修正条件を満たしていません",
              code: "MISLINK_BLOCKED",
              blockReasons: reasons,
            },
          },
          statusFromReasons(reasons),
        );
      }
      throw e;
    }

    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_mislink",
      targetTable: "property_owners",
      targetId: propertyOwnerId,
      detail: {
        correctionType: "mislink",
        operation: op,
        dryRun: false,
        propertyId,
        propertyOwnerId,
        previousOwnerId: currentOwnerId,
        newOwnerId: targetOwnerId,
        currentOwnerVersionBefore: currentOwnerVersion,
        currentOwnerVersionAfter: newCurrentOwnerVersion,
        targetOwnerVersionBefore: targetOwnerVersion,
        targetOwnerVersionAfter: newTargetOwnerVersion,
        propertyVersionBefore: propertyVersion,
        propertyVersionAfter: newPropertyVersion,
        ownerMemoCountOnThisProperty,
      },
    });

    return apiResponse({
      executed: true,
      operation: op,
      propertyId,
      propertyOwnerId,
      result: {
        removed: op === "remove",
        previousOwnerId: currentOwnerId,
        newOwnerId: targetOwnerId,
        currentOwnerVersion: newCurrentOwnerVersion,
        targetOwnerVersion: newTargetOwnerVersion,
        propertyVersion: newPropertyVersion,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
