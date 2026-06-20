import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";

/**
 * GET /api/attachments/trash — 削除済み（soft-delete）添付の一覧（ゴミ箱・admin オーバーサイト）。
 * #198 横断検索と同じ admin ゲート（実効権限 + owner PII 全可視）。返却はメタのみ・
 * fileUrl 非返却・registry は generic 名。schema 変更なし（Task 1 の deletedAt を表示）。
 */
const RESULT_LIMIT = 200;
const OWNER_PII_VISIBLE_LEVELS: ReadonlySet<string> = new Set(["edit", "full", "read"]);

export async function GET(_request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const ownerDisplay = await getOwnerDisplayConfig(session.id, perms);
    const allOwnerPiiVisible = Object.values(ownerDisplay).every((level) =>
      OWNER_PII_VISIBLE_LEVELS.has(level as string),
    );
    const allowed =
      hasPermission(perms, "user_management", "read") &&
      hasPermission(perms, "property", "read") &&
      hasPermission(perms, "owner", "read") &&
      allOwnerPiiVisible;
    if (!allowed) {
      throw new ApiError(403, "この操作の権限がありません", "FORBIDDEN");
    }

    const rows = await prisma.attachment.findMany({
      where: { isDeleted: true },
      select: {
        id: true,
        fileName: true,
        type: true,
        createdAt: true,
        deletedAt: true,
        targetType: true,
        targetId: true,
      },
      orderBy: { deletedAt: "desc" },
      take: RESULT_LIMIT,
    });

    // registry は fileName に PII を含み得るため generic に伏せる（attachment-tab と同方針）。
    const data = rows.map((r) =>
      r.type === "registry" ? { ...r, fileName: "registry.pdf" } : r,
    );

    await writeAuditLog({
      userId: session.id,
      action: "attachment_trash_list",
      targetTable: "attachments",
      detail: { resultCount: data.length },
    });

    return apiResponse({ data, count: data.length, limit: RESULT_LIMIT });
  } catch (error) {
    return handleApiError(error);
  }
}
