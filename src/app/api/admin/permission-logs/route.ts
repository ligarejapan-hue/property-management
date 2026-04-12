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

// ---------- GET /api/admin/permission-logs ----------

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "audit_log", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const params = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(params.get("page") ?? "1"));
    const limit = Math.min(100, parseInt(params.get("limit") ?? "50"));
    const userId = params.get("userId") ?? "";
    const changeType = params.get("changeType") ?? "";
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";

    const where: Record<string, unknown> = {};
    if (userId) where.targetUserId = userId;
    if (changeType) where.changeType = changeType;
    if (from || to) {
      const createdAt: Record<string, Date> = {};
      if (from) createdAt.gte = new Date(from);
      if (to) createdAt.lte = new Date(to + "T23:59:59Z");
      where.createdAt = createdAt;
    }

    const [logs, total] = await Promise.all([
      prisma.permissionChangeLog.findMany({
        where,
        include: {
          targetUser: { select: { id: true, name: true } },
          changer: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.permissionChangeLog.count({ where }),
    ]);

    return apiResponse({ data: logs, total, page, limit });
  } catch (error) {
    return handleApiError(error);
  }
}
