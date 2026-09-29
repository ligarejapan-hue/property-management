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
import { getStorage } from "@/lib/storage";
import { lockBuildingRow } from "@/lib/edit-lock/row-locks";
import { extractStorageKeyFromUrl } from "@/lib/storage/url-to-key";

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

    const fileUrlBeforeDelete = photo.fileUrl;
    // ⚠2人がほぼ同時に削除すると、後の人の delete が「対象が無い」で 500 になっていた。
    //   0件なら 404(ほかの操作で削除済み)で知らせ、実体ファイルの削除にも進まない。
    const removed = await prisma.buildingPhoto.deleteMany({ where: { id: photoId, buildingId: id } });
    if (removed.count === 0) {
      throw new ApiError(404, "写真が見つかりません(ほかの操作で削除された可能性があります)", "NOT_FOUND");
    }

    // best-effort: DB 削除成功後に実体ファイルも消す。失敗は orphan を残すだけで
    // ユーザ向け成功レスポンスは維持する（DB が source of truth）。
    const storageKey = extractStorageKeyFromUrl(fileUrlBeforeDelete);
    if (storageKey != null) {
      try {
        await getStorage().delete(storageKey);
      } catch (err) {
        console.error("[photo_delete] storage.delete failed", {
          route: "DELETE /api/buildings/[id]/photos/[photoId]",
          photoId,
          buildingId: id,
          errorName: err instanceof Error ? err.name : "Unknown",
        });
      }
    }

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

    // isPrimary を true にする場合は同棟の他写真を false に戻す。
    // ⚠同じトランザクションで、先に棟の行を押さえてから行う(物件の写真と同じ理由=
    //   tx 外の2文だと、2人が別々の写真を同時に代表にすると代表が2枚になりえた)。
    const updated = await prisma.$transaction(async (tx) => {
      await lockBuildingRow(tx, id);
      if (body.isPrimary === true) {
        await tx.buildingPhoto.updateMany({
          where: { buildingId: id, id: { not: photoId }, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const applied = await tx.buildingPhoto.updateMany({
        where: { id: photoId, buildingId: id },
        data: {
          ...(body.caption !== undefined && { caption: body.caption?.trim() || null }),
          ...(body.isPrimary !== undefined && { isPrimary: body.isPrimary }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        },
      });
      if (applied.count === 0) {
        // ⚠この写真が途中で削除されていた(ほかの操作と競合)。以前は update が「対象が無い」で
        //   失敗して 500 になっていた。404 で知らせる(tx の中で投げる=他の代表を外した分も巻き戻る)。
        throw new ApiError(404, "写真が見つかりません(ほかの操作で削除された可能性があります)", "NOT_FOUND");
      }
      return tx.buildingPhoto.findUnique({
        where: { id: photoId },
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
