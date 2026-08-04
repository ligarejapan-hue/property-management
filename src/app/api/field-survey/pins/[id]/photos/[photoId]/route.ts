import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { touchTripActivity } from "@/lib/field-survey-auto-end";
import { getStorage } from "@/lib/storage";
import { extractStorageKeyFromUrl } from "@/lib/storage/url-to-key";

// ---------- DELETE /api/field-survey/pins/[id]/photos/[photoId] ----------
//
// Phase 1-H: own pin + field_survey:write のみ削除可。archived 不可。
// 他人 pin は read_all / manage を持っていても削除不可。
// DB delete 後に best-effort で storage 実体を消す。storage.delete 失敗は
// orphan を残すだけで API は成功扱い (DB が source of truth)。
// AuditLog は pinId / photoId のみ (URL / storageKey / fileName / 座標 / PII を出さない)。

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "写真の削除権限がありません", "FORBIDDEN");
    }

    const photo = await prisma.fieldSurveyPinPhoto.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        pinId: true,
        fileUrl: true,
        thumbnailUrl: true,
        // sessionId は巡回の活動更新に使う(@codex #356 P2)。
        pin: { select: { staffUserId: true, status: true, sessionId: true } },
      },
    });
    if (!photo || photo.pinId !== id) {
      throw new ApiError(404, "写真が見つかりません", "NOT_FOUND");
    }

    if (photo.pin.staffUserId !== session.id) {
      throw new ApiError(403, "他スタッフの pin の写真は削除できません", "FORBIDDEN");
    }
    if (photo.pin.status === "archived") {
      throw new ApiError(
        409,
        "アーカイブ済の pin の写真は削除できません",
        "INVALID_STATE",
      );
    }

    const fileUrlBeforeDelete = photo.fileUrl;
    const thumbnailUrlBeforeDelete = photo.thumbnailUrl;
    // ⚠**削除と心拍を同じ transaction で行う**(@codex #356 P2)。別々だと、
    // 削除が commit してから心拍が走るまでの隙間に見回りが入り込み、
    // 「本当に操作しているのに終了させられる」。撮り直し(消して撮る)を
    // 繰り返している最中に切られないようにする。
    // ⚠**心拍を先に打つ**(@codex #356 P1)。写真を消してから打つと、その間は
    // 巡回の行に触っていないため、見回りが横から巡回を終了させられる
    // (心拍は 0 行更新で黙って終わるので、操作中なのに終了が成立してしまう)。
    await prisma.$transaction(async (tx) => {
      await touchTripActivity(tx, photo.pin?.sessionId ?? null);
      await tx.fieldSurveyPinPhoto.delete({ where: { id: photoId } });
    });

    // best-effort: 本体 + (あれば) thumbnail の実体を消す。fileUrl は /uploads/...
    // proxy 相対なので extractStorageKeyFromUrl で key を復元できる。
    // storage.delete 失敗は orphan を残すだけで API は成功扱い (DB が source of truth)。
    const storage = getStorage();
    for (const url of [fileUrlBeforeDelete, thumbnailUrlBeforeDelete]) {
      const storageKey = extractStorageKeyFromUrl(url);
      if (storageKey == null) continue;
      try {
        await storage.delete(storageKey);
      } catch (err) {
        console.error("[field_survey_pin_photo_delete] storage.delete failed", {
          route: "DELETE /api/field-survey/pins/[id]/photos/[photoId]",
          pinId: id,
          photoId,
          errorName: err instanceof Error ? err.name : "Unknown",
        });
      }
    }

    await writeAuditLog({
      userId: session.id,
      action: "field_survey_pin_photo_delete",
      targetTable: "field_survey_pin_photos",
      targetId: photoId,
      detail: { pinId: id, photoId },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
