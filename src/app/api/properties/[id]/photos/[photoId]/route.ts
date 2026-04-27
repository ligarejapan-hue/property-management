import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";

// ---------- DELETE /api/properties/[id]/photos/[photoId] ----------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    // Verify photo exists and belongs to the property
    const photo = await prisma.propertyPhoto.findUnique({
      where: { id: photoId },
      include: {
        property: { select: { createdBy: true, assignedTo: true } },
      },
    });

    if (!photo || photo.propertyId !== id) {
      throw new ApiError(404, "写真が見つかりません", "NOT_FOUND");
    }

    // field_staff scope check
    if (
      session.role === "field_staff" &&
      photo.property.createdBy !== session.id &&
      photo.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この写真を削除する権限がありません", "FORBIDDEN");
    }

    await prisma.propertyPhoto.delete({ where: { id: photoId } });

    await writeAuditLog({
      userId: session.id,
      action: "photo_delete",
      targetTable: "property_photos",
      targetId: photoId,
      detail: { propertyId: id, fileName: photo.fileName },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/properties/[id]/photos/[photoId] ----------
// キャプション更新 / 代表画像フラグ切り替え / 並び順更新

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const photo = await prisma.propertyPhoto.findUnique({
      where: { id: photoId },
      include: {
        property: { select: { createdBy: true, assignedTo: true } },
      },
    });

    if (!photo || photo.propertyId !== id) {
      throw new ApiError(404, "写真が見つかりません", "NOT_FOUND");
    }

    if (
      session.role === "field_staff" &&
      photo.property.createdBy !== session.id &&
      photo.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この写真を編集する権限がありません", "FORBIDDEN");
    }

    const body = (await request.json()) as {
      caption?: string | null;
      isPrimary?: boolean;
      sortOrder?: number;
    };

    if (body.isPrimary === true) {
      await prisma.propertyPhoto.updateMany({
        where: { propertyId: id, id: { not: photoId } },
        data: { isPrimary: false },
      });
    }

    const updated = await prisma.propertyPhoto.update({
      where: { id: photoId },
      data: {
        ...(body.caption !== undefined && { caption: body.caption?.trim() || null }),
        ...(body.isPrimary !== undefined && { isPrimary: body.isPrimary }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      },
      include: {
        photographer: { select: { id: true, name: true } },
      },
    });

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
