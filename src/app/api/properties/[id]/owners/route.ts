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
import { linkOwnerSchema } from "@/lib/validators";
import { hasPermission } from "@/lib/permissions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = linkOwnerSchema.parse(body);

    // Verify property exists
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // Verify owner exists
    const owner = await prisma.owner.findUnique({
      where: { id: data.ownerId },
      select: { id: true },
    });
    if (!owner) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // If isPrimary, unset existing primary owner for this property
    if (data.isPrimary) {
      await prisma.propertyOwner.updateMany({
        where: { propertyId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const propertyOwner = await prisma.propertyOwner.create({
      data: {
        propertyId,
        ownerId: data.ownerId,
        relationship: data.relationship,
        isPrimary: data.isPrimary,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      detail: { propertyId, ownerId: data.ownerId },
    });

    return apiResponse(propertyOwner, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
