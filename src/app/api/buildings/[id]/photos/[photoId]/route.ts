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

// ---------- DELETE /api/buildings/[id]/photos/[photoId] ----------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "棟編集の権限がありません", "FORBIDDEN");
    }

    const photo = await prisma.buildingPhoto.findUnique({
      where: { id: photoId },
    });

    if (!photo || photo.buildingId !== id) {
      throw new ApiError(404, "写真が見つかりません", "NOT_FOUND");
    }

    await prisma.buildingPhoto.delete({ where: { id: photoId } });

    await writeAuditLog({
      userId: session.id,
      action: "photo_delete",
      targetTable: "building_photos",
      targetId: photoId,
      detail: { buildingId: id, fileName: photo.fileName },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/buildings/[id]/photos/[photoId] ----------
// キャプション更新 / 代表画像フラグ切り替え

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "棟編集の権限がありません", "FORBIDDEN");
    }

    const photo = await prisma.buildingPhoto.findUnique({
      where: { id: photoId },
    });

    if (!photo || photo.buildingId !== id) {
      throw new ApiError(404, "写真が見つかりません", "NOT_FOUND");
    }

    const body = await request.json() as {
      caption?: string | null;
      isPrimary?: boolean;
      sortOrder?: number;
    };

    // isPrimary を true にする場合は同棟の他写真を false に戻す
    if (body.isPrimary === true) {
      await prisma.buildingPhoto.updateMany({
        where: { buildingId: id, id: { not: photoId } },
        data: { isPrimary: false },
      });
    }

    const updated = await prisma.buildingPhoto.update({
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
