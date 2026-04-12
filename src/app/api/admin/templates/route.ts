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

// ---------- GET /api/admin/templates ----------

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const templates = await prisma.permissionTemplate.findMany({
      include: {
        templatePermissions: {
          select: { resource: true, action: true, granted: true },
        },
      },
      orderBy: { name: "asc" },
    });

    return apiResponse({ data: templates });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/admin/templates ----------

const createTemplateSchema = z.object({
  name: z.string().min(1, "テンプレート名は必須です").max(100),
  description: z.string().max(500).optional(),
  permissions: z.array(
    z.object({
      resource: z.string(),
      action: z.string(),
      granted: z.boolean(),
    }),
  ),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = createTemplateSchema.parse(body);

    const existing = await prisma.permissionTemplate.findUnique({
      where: { name: data.name },
    });
    if (existing) {
      throw new ApiError(409, "同名のテンプレートが既に存在します", "CONFLICT");
    }

    const template = await prisma.permissionTemplate.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        templatePermissions: {
          create: data.permissions.map((p) => ({
            resource: p.resource,
            action: p.action,
            granted: p.granted,
          })),
        },
      },
      include: {
        templatePermissions: {
          select: { resource: true, action: true, granted: true },
        },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "template_create",
      targetTable: "permission_templates",
      targetId: template.id,
      detail: { name: data.name, permissionCount: data.permissions.length },
    });

    return apiResponse({ data: template }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
