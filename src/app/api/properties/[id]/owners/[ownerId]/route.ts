import { NextRequest } from "next/server";
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
