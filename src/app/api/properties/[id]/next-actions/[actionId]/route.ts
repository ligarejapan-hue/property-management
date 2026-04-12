import { NextRequest } from "next/server";
import { z } from "zod";
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

const updateNextActionSchema = z.object({
  isCompleted: z.boolean().optional(),
  assignedTo: z.string().uuid().optional(),
  scheduledAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  actionType: z.string().max(50).optional().nullable(),
  content: z.string().min(1, "内容は必須です").max(1000, "内容は1000文字以内です").optional(),
});

// ---------- PATCH /api/properties/:id/next-actions/:actionId ----------

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; actionId: string }> },
) {
  try {
    const { id: propertyId, actionId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.nextAction.findUnique({
      where: { id: actionId },
    });
    if (!existing || existing.propertyId !== propertyId) {
      throw new ApiError(404, "アクションが見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = updateNextActionSchema.parse(body);

    const updateData: Record<string, unknown> = {};
    if (data.content !== undefined) updateData.content = data.content;
    if (data.assignedTo !== undefined) updateData.assignedTo = data.assignedTo;
    if (data.actionType !== undefined) updateData.actionType = data.actionType;
    if (data.scheduledAt !== undefined)
      updateData.scheduledAt = new Date(data.scheduledAt);
    if (data.isCompleted !== undefined) {
      updateData.isCompleted = data.isCompleted;
      updateData.completedAt = data.isCompleted ? new Date() : null;
    }

    const updated = await prisma.nextAction.update({
      where: { id: actionId },
      data: updateData,
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: data.isCompleted ? "complete" : "update",
      targetTable: "next_actions",
      targetId: actionId,
      detail: { propertyId, updatedFields: Object.keys(data) },
    });

    return apiResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/properties/:id/next-actions/:actionId ----------

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; actionId: string }> },
) {
  try {
    const { id: propertyId, actionId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.nextAction.findUnique({
      where: { id: actionId },
    });
    if (!existing || existing.propertyId !== propertyId) {
      throw new ApiError(404, "アクションが見つかりません", "NOT_FOUND");
    }

    await prisma.nextAction.delete({ where: { id: actionId } });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "next_actions",
      targetId: actionId,
      detail: { propertyId },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
