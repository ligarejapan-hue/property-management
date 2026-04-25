import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import { hasPermission } from "@/lib/permissions";

// 物件×所有者単位のメモ更新（PropertyOwner.note）。
// Owner.note (所有者全体のメモ) と混同しないこと。
const patchPropertyOwnerSchema = z.object({
  note: z.string().nullable().optional(),
  relationship: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ownerId: string }> },
) {
  try {
    const { id: propertyId, ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = patchPropertyOwnerSchema.parse(body);

    const existing = await prisma.propertyOwner.findUnique({
      where: { propertyId_ownerId: { propertyId, ownerId } },
    });
    if (!existing) {
      throw new ApiError(
        404,
        "物件と所有者の紐付けが見つかりません",
        "NOT_FOUND",
      );
    }

    const updateData: Record<string, unknown> = {};
    if (data.note !== undefined) updateData.note = data.note;
    if (data.relationship !== undefined)
      updateData.relationship = data.relationship;
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;

    // isPrimary を立てる場合は同一物件の他リンクを下ろす
    if (data.isPrimary === true) {
      await prisma.propertyOwner.updateMany({
        where: { propertyId, isPrimary: true, NOT: { id: existing.id } },
        data: { isPrimary: false },
      });
    }

    const updated = await prisma.propertyOwner.update({
      where: { id: existing.id },
      data: updateData,
    });

    await recordChanges({
      targetTable: "property_owners",
      targetId: existing.id,
      changedBy: session.id,
      oldValues: {
        note: existing.note,
        relationship: existing.relationship,
        isPrimary: existing.isPrimary,
      },
      newValues: updateData,
      trackedFields: ["note", "relationship", "isPrimary"],
    });

    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "property_owners",
      targetId: existing.id,
      detail: { propertyId, ownerId, fields: Object.keys(updateData) },
    });

    return apiResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; ownerId: string }> },
) {
  try {
    const { id: propertyId, ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // Find the PropertyOwner record
    const propertyOwner = await prisma.propertyOwner.findUnique({
      where: {
        propertyId_ownerId: {
          propertyId,
          ownerId,
        },
      },
    });

    if (!propertyOwner) {
      throw new ApiError(
        404,
        "物件と所有者の紐付けが見つかりません",
        "NOT_FOUND",
      );
    }

    // Delete the link
    await prisma.propertyOwner.delete({
      where: { id: propertyOwner.id },
    });

    // Record change log for the unlink
    await recordChanges({
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      changedBy: session.id,
      oldValues: {
        propertyId: propertyOwner.propertyId,
        ownerId: propertyOwner.ownerId,
        relationship: propertyOwner.relationship,
        isPrimary: propertyOwner.isPrimary,
      },
      newValues: {},
      trackedFields: ["propertyId", "ownerId", "relationship", "isPrimary"],
    });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      detail: { propertyId, ownerId },
    });

    return apiResponse({ message: "紐付けを解除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
