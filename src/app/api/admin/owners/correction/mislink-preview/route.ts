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
// POST /api/admin/owners/correction/mislink-preview
// ---------------------------------------------------------------------------
// Phase 2-C: PropertyOwner 誤紐づき修正の dryRun preview。
//
// このルートは DB を一切更新しない。
//
// 権限:
//   - user_management:read + owner:read + property:read
//   - property record-scope: canAccessPropertyRecord (field_staff は createdBy/assignedTo のみ)
//
// Request body:
//   {
//     operation: "remove" | "relink",
//     propertyId: string (UUID),
//     propertyOwnerId: string (UUID),
//     currentOwnerId: string (UUID),
//     targetOwnerId?: string (UUID, relink でのみ必須)
//   }
//
// レスポンス（PII を含まない・enum / ID / 件数 / boolean のみ）:
//   200 {
//     eligible: boolean,
//     blockReasons: OwnerMislinkBlockReason[],
//     propertyId, propertyOwnerId, operation,
//     summary: {
//       currentOwnerId, currentOwnerArchived,
//       targetOwnerId | null, targetOwnerArchived,
//       targetAlreadyLinked,
//       propertyArchived,
//       ownerMemoCountOnThisProperty,
//       currentOwnerVersion, targetOwnerVersion | null, propertyVersion
//     }
//   }
//   400 UUID / operation 不正
//   403 権限不足
//   404 property / propertyOwner / currentOwner 全て不存在（特殊扱い）
//   422 same_owner_id 等で preview 自体が無意味
//
// archived owner / target_already_linked などは 200 + blockReasons として返す。
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  operation?: unknown;
  propertyId?: unknown;
  propertyOwnerId?: unknown;
  currentOwnerId?: unknown;
  targetOwnerId?: unknown;
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_REGEX.test(v);
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
    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const operation = body.operation;
    const propertyId = body.propertyId;
    const propertyOwnerId = body.propertyOwnerId;
    const currentOwnerId = body.currentOwnerId;
    const targetOwnerIdRaw = body.targetOwnerId;

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

    // same_owner_id は 422
    if (op === "relink" && targetOwnerId === currentOwnerId) {
      return apiResponse(
        {
          error: {
            message: "current と target に同じ所有者を指定できません",
            code: "MISLINK_PREVIEW_BLOCKED",
            blockReasons: ["same_owner_id"] satisfies OwnerMislinkBlockReason[],
          },
        },
        422,
      );
    }

    // 各エンティティ取得
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

    // 三つともすべて存在しない場合は 404
    if (!propertyOwner && !property && !currentOwner) {
      throw new ApiError(404, "対象が見つかりません", "NOT_FOUND");
    }

    // property record-scope: field_staff は createdBy / assignedTo のみ
    if (property && !canAccessPropertyRecord(session, property)) {
      throw new ApiError(
        403,
        "この物件を閲覧する権限がありません",
        "FORBIDDEN",
      );
    }

    // target がもし同 property に既に紐づいているか
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

    // OwnerMemo 件数（currentOwner + propertyId）
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
      // preview ではバージョンチェック不要 (execute 時に行う)
      propertyVersionMatches: true,
      currentOwnerExists: currentOwner !== null,
      currentOwnerVersionMatches: true,
      targetOwnerExists: targetOwner !== null,
      targetOwnerIsArchived: targetOwner?.isArchived ?? false,
      targetOwnerVersionMatches: true,
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

    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_mislink_preview",
      targetTable: "property_owners",
      targetId: propertyOwnerId,
      detail: {
        correctionType: "mislink",
        operation: op,
        propertyId,
        propertyOwnerId,
        currentOwnerId,
        targetOwnerId,
        eligible,
        blockReasons,
        ownerMemoCountOnThisProperty,
      },
    });

    return apiResponse({
      eligible,
      blockReasons,
      propertyId,
      propertyOwnerId,
      operation: op,
      summary,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
