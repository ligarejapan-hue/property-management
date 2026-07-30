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
import { assertPropertyRecordAccess } from "@/lib/property-record-guard";

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

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    // 対応予定は自由記述1000文字で顧客の事情が入るため、担当外には出さない。
    await assertPropertyRecordAccess(propertyId, session, "read");

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

    // 物件の存在確認（404）と担当者スコープ（403）を兼ねる（発注者判断 2026-07-30）。
    await assertPropertyRecordAccess(propertyId, session, "write");

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
