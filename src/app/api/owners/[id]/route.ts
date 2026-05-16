import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import { updateOwnerSchema } from "@/lib/validators";
import { hasPermission } from "@/lib/permissions";
import { applyDisplayToOwner } from "@/lib/display-level";
import type { OwnerDisplayConfig } from "@/lib/display-level";

// ---------------------------------------------------------------------------
// GET /api/owners/:id
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      include: {
        propertyOwners: {
          include: {
            property: {
              select: {
                id: true,
                address: true,
                propertyType: true,
                caseStatus: true,
              },
            },
          },
        },
      },
    });

    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const displayConfig = await getOwnerDisplayConfig(session.id);
    const filtered = applyDisplayToOwner(owner, displayConfig);

    await writeAuditLog({
      userId: session.id,
      action: "owner_view",
      targetTable: "owners",
      targetId: id,
    });

    return apiResponse(filtered);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/owners/:id
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { version, ...updateFields } = updateOwnerSchema.parse(body);

    // Get current owner for change tracking
    const currentOwner = await prisma.owner.findUnique({ where: { id } });
    if (!currentOwner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // Optimistic lock update
    const result = await prisma.owner.updateMany({
      where: { id, version },
      data: {
        ...updateFields,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
    }

    // Record change logs
    await recordChanges({
      targetTable: "owners",
      targetId: id,
      changedBy: session.id,
      oldValues: currentOwner as unknown as Record<string, unknown>,
      newValues: updateFields as Record<string, unknown>,
      trackedFields: OWNER_TRACKED_FIELDS,
    });

    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "owners",
      targetId: id,
      detail: { updatedFields: Object.keys(updateFields) },
    });

    // Fetch updated owner and apply display level
    const updatedOwner = await prisma.owner.findUniqueOrThrow({
      where: { id },
      include: {
        propertyOwners: {
          include: {
            property: {
              select: {
                id: true,
                address: true,
                propertyType: true,
                caseStatus: true,
              },
            },
          },
        },
      },
    });

    const displayConfig = await getOwnerDisplayConfig(session.id);
    const filtered = applyDisplayToOwner(updatedOwner, displayConfig);

    return apiResponse(filtered);
  } catch (error) {
    return handleApiError(error);
  }
}
