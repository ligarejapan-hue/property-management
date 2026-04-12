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

const createCommentSchema = z.object({
  body: z.string().min(1, "コメント本文は必須です").max(2000),
  parentId: z.string().uuid().optional().nullable(),
});

// ---------- GET /api/properties/:id/comments ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // Fetch top-level comments with one level of replies
    const comments = await prisma.comment.findMany({
      where: { propertyId, parentId: null },
      include: {
        author: { select: { id: true, name: true } },
        replies: {
          include: {
            author: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return apiResponse({ data: comments });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/properties/:id/comments ----------

export async function POST(
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

    // Verify property exists
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = createCommentSchema.parse(body);

    // If replying, verify parent exists and belongs to same property
    if (data.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: data.parentId },
        select: { propertyId: true },
      });
      if (!parent || parent.propertyId !== propertyId) {
        throw new ApiError(404, "返信先のコメントが見つかりません", "NOT_FOUND");
      }
    }

    const comment = await prisma.comment.create({
      data: {
        propertyId,
        authorId: session.id,
        body: data.body,
        parentId: data.parentId ?? null,
      },
      include: {
        author: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "comments",
      targetId: comment.id,
      detail: { propertyId, parentId: data.parentId ?? null },
    });

    return apiResponse(comment, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
