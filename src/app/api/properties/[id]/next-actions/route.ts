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

const createNextActionSchema = z.object({
  assignedTo: z.string().uuid("担当者IDが不正です"),
  scheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付はYYYY-MM-DD形式で指定してください"),
  actionType: z.string().max(50).optional().nullable(),
  content: z.string().min(1, "内容は必須です").max(1000),
});

// ---------- GET /api/properties/:id/next-actions ----------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const includeCompleted = searchParams.get("includeCompleted") === "true";

    const where: Record<string, unknown> = { propertyId };
    if (!includeCompleted) {
      where.isCompleted = false;
    }

    const actions = await prisma.nextAction.findMany({
      where,
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { scheduledAt: "asc" },
    });

    return apiResponse({ data: actions });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/properties/:id/next-actions ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = createNextActionSchema.parse(body);

    const action = await prisma.nextAction.create({
      data: {
        propertyId,
        assignedTo: data.assignedTo,
        scheduledAt: new Date(data.scheduledAt),
        actionType: data.actionType ?? null,
        content: data.content,
        createdBy: session.id,
      },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "next_actions",
      targetId: action.id,
      detail: { propertyId, actionType: data.actionType },
    });

    return apiResponse(action, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
