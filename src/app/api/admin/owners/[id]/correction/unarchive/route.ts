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
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:ownerId/correction/unarchive
// ---------------------------------------------------------------------------
// アーカイブした所有者を一覧・検索に戻す(2026-11-24 発注者「作る」)。
//
// 権限: アーカイブの実行と同じ(user_management:read + owner:read + owner:delete)。
// Request body: { version: number }
// レスポンス(PII なし):
//   200 { executed: true, id, version }
//   400 version 不正 / 403 権限不足
//   404 所有者が無い・アーカイブされていない
//   409 版が違う(誰かが先に戻した・直した)
//
// 戻すのは isArchived だけ。統合で隠れた人の物件・メモ・DM の記録は統合先に残ったまま
// (付け替えを巻き戻さない)。戻した人は物件につながっていない所有者として現れる。
// ---------------------------------------------------------------------------

const TX_NOT_FOUND = "__unarchive_not_found__";
const TX_CONFLICT = "__unarchive_conflict__";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "delete")) {
      throw new ApiError(403, "アーカイブを戻す権限がありません", "FORBIDDEN");
    }

    const body = await request.json().catch(() => ({}));
    const version = body?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "version は正の整数で指定してください", "INVALID_INPUT");
    }

    try {
      await prisma.$transaction(async (tx) => {
        // アーカイブ・統合と同じ行を取り合って直列にする。
        await lockOwnerRow(tx, ownerId);
        const cur = await tx.owner.findUnique({
          where: { id: ownerId },
          select: { version: true, isArchived: true },
        });
        if (!cur || !cur.isArchived) throw new Error(TX_NOT_FOUND);
        if (cur.version !== version) throw new Error(TX_CONFLICT);

        const result = await tx.owner.updateMany({
          where: { id: ownerId, version, isArchived: true },
          data: { isArchived: false, version: { increment: 1 } },
        });
        if (result.count === 0) throw new Error(TX_CONFLICT);

        await tx.changeLog.create({
          data: {
            targetTable: "owners",
            targetId: ownerId,
            fieldName: "isArchived",
            oldValue: "true",
            newValue: "false",
            source: "manual",
            changedBy: session.id,
          },
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === TX_NOT_FOUND) {
        throw new ApiError(404, "アーカイブ済みの所有者が見つかりません", "NOT_FOUND");
      }
      if (e instanceof Error && e.message === TX_CONFLICT) {
        throw new ApiError(
          409,
          "ほかの人が先に変更しました。一覧を読み直してください",
          "VERSION_MISMATCH",
        );
      }
      throw e;
    }

    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_unarchive",
      targetTable: "owners",
      targetId: ownerId,
      detail: { correctionType: "unarchive", updatedFields: ["isArchived"] },
    });

    return apiResponse({ executed: true, id: ownerId, version: version + 1 });
  } catch (error) {
    return handleApiError(error);
  }
}
