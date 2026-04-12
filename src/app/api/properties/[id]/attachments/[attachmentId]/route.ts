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
import { hasPermission } from "@/lib/permissions";

// ---------- DELETE /api/properties/:id/attachments/:attachmentId ----------
// Soft-delete (sets isDeleted = true)

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; attachmentId: string }> },
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
    });
    if (
      !attachment ||
      attachment.targetId !== propertyId ||
      attachment.isDeleted
    ) {
      throw new ApiError(404, "添付ファイルが見つかりません", "NOT_FOUND");
    }

    await prisma.attachment.update({
      where: { id: attachmentId },
      data: { isDeleted: true },
    });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "attachments",
      targetId: attachmentId,
      detail: { propertyId, fileName: attachment.fileName },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
