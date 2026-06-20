import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";

// POST /api/properties/:id/attachments/:attachmentId/restore — soft-delete の取消（ゴミ箱から復元）
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { id: propertyId, attachmentId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { property: { select: { createdBy: true, assignedTo: true } } },
    });
    if (!attachment || attachment.targetId !== propertyId || !attachment.isDeleted) {
      throw new ApiError(404, "添付ファイルが見つかりません", "NOT_FOUND");
    }
    if (attachment.property && !canAccessPropertyRecord(session, attachment.property)) {
      throw new ApiError(403, "この添付ファイルを復元する権限がありません", "FORBIDDEN");
    }
    await prisma.attachment.update({
      where: { id: attachmentId },
      data: { isDeleted: false, deletedAt: null },
    });
    await writeAuditLog({
      userId: session.id,
      action: "restore",
      targetTable: "attachments",
      targetId: attachmentId,
      detail: { propertyId },
    });
    return apiResponse({ message: "復元しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
