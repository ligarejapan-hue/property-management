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
import { canAccessPropertyRecord } from "@/lib/property-access";
import { lockPropertyRecordForWrite } from "@/lib/property-record-guard";
import { getStorage } from "@/lib/storage";
import { extractStorageKeyFromUrl } from "@/lib/storage/url-to-key";

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

    // field_staff scope check（物件詳細 API と同一判定を共有）
    if (!canAccessPropertyRecord(session, photo.property)) {
      throw new ApiError(403, "この写真を削除する権限がありません", "FORBIDDEN");
    }

    const fileUrlBeforeDelete = photo.fileUrl;
    await prisma.propertyPhoto.delete({ where: { id: photoId } });

    // best-effort: DB 削除成功後に実体ファイルも消す。失敗は orphan を残すだけで
    // ユーザ向け成功レスポンスは維持する（DB が source of truth）。
    const storageKey = extractStorageKeyFromUrl(fileUrlBeforeDelete);
    if (storageKey != null) {
      try {
        await getStorage().delete(storageKey);
      } catch (err) {
        console.error("[photo_delete] storage.delete failed", {
          route: "DELETE /api/properties/[id]/photos/[photoId]",
          photoId,
          propertyId: id,
          errorName: err instanceof Error ? err.name : "Unknown",
        });
      }
    }

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

    if (!canAccessPropertyRecord(session, photo.property)) {
      throw new ApiError(403, "この写真を編集する権限がありません", "FORBIDDEN");
    }

    const body = (await request.json()) as {
      caption?: string | null;
      isPrimary?: boolean;
      sortOrder?: number;
    };

    // ⚠「他の代表を外す」と「この写真を代表にする」は同じトランザクションで、先に
    //   親の物件行を押さえてから行う(物件配下の書き込み規約=親 → 子)。以前は tx 外の
    //   2文だったため、2人が別々の写真を同時に代表にすると代表が2枚になりえた。
    //   押さえた後は同じ物件の切り替えが直列になり、後から押した写真が代表になる。
    //   ロックは担当者スコープつき=判定から書き込みまでの間に担当が外れたら403。
    const updated = await prisma.$transaction(async (tx) => {
      await lockPropertyRecordForWrite(tx, id, session);
      if (body.isPrimary === true) {
        await tx.propertyPhoto.updateMany({
          where: { propertyId: id, id: { not: photoId }, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.propertyPhoto.update({
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
    });

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
