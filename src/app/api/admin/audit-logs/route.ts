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

// ---------- GET /api/admin/audit-logs ----------

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
    const action = params.get("action") ?? "";
    const userId = params.get("userId") ?? "";
    const userName = params.get("userName") ?? "";
    const targetTable = params.get("targetTable") ?? "";
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";

    const where: Record<string, unknown> = {};
    if (action) where.action = action;
    if (userId) where.userId = userId;
    if (targetTable) where.targetTable = targetTable;
    if (from || to) {
      const createdAt: Record<string, Date> = {};
      if (from) createdAt.gte = new Date(from);
      if (to) createdAt.lte = new Date(to + "T23:59:59Z");
      where.createdAt = createdAt;
    }

    // User name search (partial match)
    if (userName) {
      where.user = {
        name: { contains: userName },
      };
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Get distinct actions and targetTables for filter dropdowns
    const [actions, targetTables] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ["action"],
        orderBy: { action: "asc" },
      }),
      prisma.auditLog.groupBy({
        by: ["targetTable"],
        orderBy: { targetTable: "asc" },
      }),
    ]);

    return apiResponse({
      data: logs,
      total,
      page,
      limit,
      actions: actions.map((a) => a.action),
      targetTables: targetTables
        .filter((t) => t.targetTable !== null)
        .map((t) => t.targetTable as string),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
