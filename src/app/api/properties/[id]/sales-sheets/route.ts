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
import { createDesign, listDesigns } from "@/lib/sales-sheet/design-service";

const createBodySchema = z.object({
  title: z.string().max(120).optional(),
  document: z.unknown(),
  templateId: z.string().optional(),
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
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }
    await getPropertyOrThrow(id, session);
    const designs = await listDesigns(id);
    return NextResponse.json(designs);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }
    await getPropertyOrThrow(id, session);
    const body = createBodySchema.parse(await parseJsonBody(request));
    const design = await createDesign({
      propertyId: id,
      title: body.title,
      document: body.document,
      templateId: body.templateId,
      userId: session.id,
    });
    return NextResponse.json({ id: design.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
