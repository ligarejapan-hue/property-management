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

// ---------- GET /api/properties/:id/change-logs ----------

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
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));
    const fieldName = searchParams.get("fieldName") ?? "";
    const source = searchParams.get("source") ?? "";
    const from = searchParams.get("from") ?? "";
    const to = searchParams.get("to") ?? "";

    // Fetch change logs for this property and its related owners
    const where: Record<string, unknown> = {
      OR: [
        { targetTable: "properties", targetId: propertyId },
        { targetTable: "property_owners", targetId: propertyId },
        { targetTable: "buildings", targetId: propertyId },
      ],
    };

    if (fieldName) where.fieldName = fieldName;
    if (source) where.source = source;
    if (from || to) {
      const changedAt: Record<string, Date> = {};
      if (from) changedAt.gte = new Date(from);
      if (to) changedAt.lte = new Date(to + "T23:59:59Z");
      where.changedAt = changedAt;
    }

    const [logs, total] = await Promise.all([
      prisma.changeLog.findMany({
        where,
        include: {
          changer: { select: { id: true, name: true } },
        },
        orderBy: { changedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.changeLog.count({ where }),
    ]);

    // Get distinct field names and sources for filter dropdowns
    const [fieldNames, sources] = await Promise.all([
      prisma.changeLog.groupBy({
        by: ["fieldName"],
        where: {
          OR: [
            { targetTable: "properties", targetId: propertyId },
            { targetTable: "property_owners", targetId: propertyId },
            { targetTable: "buildings", targetId: propertyId },
          ],
        },
        orderBy: { fieldName: "asc" },
      }),
      prisma.changeLog.groupBy({
        by: ["source"],
        where: {
          OR: [
            { targetTable: "properties", targetId: propertyId },
            { targetTable: "property_owners", targetId: propertyId },
            { targetTable: "buildings", targetId: propertyId },
          ],
        },
        orderBy: { source: "asc" },
      }),
    ]);

    return apiResponse({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      fieldNames: fieldNames.map((f) => f.fieldName),
      sources: sources.map((s) => s.source),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
