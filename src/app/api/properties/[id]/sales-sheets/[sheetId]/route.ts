import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  parseJsonBody,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { getDesign, updateDesign, deleteDesign } from "@/lib/sales-sheet/design-service";

const updateBodySchema = z.object({
  title: z.string().max(120).optional(),
  document: z.unknown().optional(),
  expectedUpdatedAt: z.string().datetime(),
});

async function getPropertyOrThrow(
  id: string,
  session: { id: string; role: string },
) {
  const property = await prisma.property.findUnique({
    where: { id },
    select: { id: true, createdBy: true, assignedTo: true },
  });
  if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
  }
  return property;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; sheetId: string }> },
) {
  try {
    const { id, sheetId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }
    await getPropertyOrThrow(id, session);
    const design = await getDesign(id, sheetId);
    if (!design) throw new ApiError(404, "販売図面が見つかりません", "NOT_FOUND");
    return NextResponse.json(design);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; sheetId: string }> },
) {
  try {
    const { id, sheetId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }
    await getPropertyOrThrow(id, session);
    const body = updateBodySchema.parse(await parseJsonBody(request));
    const result = await updateDesign(
      id,
      sheetId,
      { title: body.title, document: body.document, expectedUpdatedAt: body.expectedUpdatedAt },
      session.id,
    );
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new ApiError(404, "販売図面が見つかりません", "NOT_FOUND");
      }
      if (result.reason === "conflict") {
        throw new ApiError(409, "他の操作と競合しています。最新データを取得してから再試行してください", "CONFLICT");
      }
    }
    return NextResponse.json({ updatedAt: result.design.updatedAt });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; sheetId: string }> },
) {
  try {
    const { id, sheetId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }
    await getPropertyOrThrow(id, session);
    const deleted = await deleteDesign(id, sheetId);
    if (!deleted) throw new ApiError(404, "販売図面が見つかりません", "NOT_FOUND");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
