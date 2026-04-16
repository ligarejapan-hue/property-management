import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// ---------- GET /api/properties/[id]/investigation/audit-logs ----------
// Returns investigation audit log entries for a property (newest first)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 100);

    const logs = await prisma.propertyInvestigationAuditLog.findMany({
      where: { propertyId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        creator: { select: { id: true, name: true } },
      },
    });

    const auditLogs = logs.map((l) => ({
      id: l.id,
      investigationId: l.investigationId,
      action: l.action,
      beforeJson: l.beforeJson,
      afterJson: l.afterJson,
      note: l.note,
      creator: l.creator,
      createdAt: l.createdAt.toISOString(),
    }));

    return apiResponse({ auditLogs });
  } catch (error) {
    return handleApiError(error);
  }
}
