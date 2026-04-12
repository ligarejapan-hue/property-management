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

// ---------- GET /api/admin/templates/:id ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const template = await prisma.permissionTemplate.findUnique({
      where: { id },
      include: {
        templatePermissions: {
          select: { resource: true, action: true, granted: true },
        },
      },
    });

    if (!template) {
      throw new ApiError(404, "テンプレートが見つかりません", "NOT_FOUND");
    }

    return apiResponse({ data: template });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PUT /api/admin/templates/:id ----------

const updateTemplateSchema = z.object({
  name: z.string().min(1, "テンプレート名は必須です").max(100, "テンプレート名は100文字以内です"),
  description: z.string().max(500, "説明は500文字以内です").optional(),
  permissions: z.array(
    z.object({
      resource: z.string(),
      action: z.string(),
      granted: z.boolean(),
    }),
  ),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const template = await prisma.permissionTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      throw new ApiError(404, "テンプレートが見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = updateTemplateSchema.parse(body);

    // Check name uniqueness (excluding self)
    const nameConflict = await prisma.permissionTemplate.findFirst({
      where: { name: data.name, id: { not: id } },
    });
    if (nameConflict) {
      throw new ApiError(409, "同名のテンプレートが既に存在します", "CONFLICT");
    }

    // Delete existing permissions and recreate
    await prisma.templatePermission.deleteMany({
      where: { templateId: id },
    });

    const updated = await prisma.permissionTemplate.update({
      where: { id },
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
      action: "template_update",
      targetTable: "permission_templates",
      targetId: id,
      detail: {
        name: data.name,
        permissionCount: data.permissions.length,
      },
    });

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/admin/templates/:id ----------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "delete")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const template = await prisma.permissionTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      throw new ApiError(404, "テンプレートが見つかりません", "NOT_FOUND");
    }

    if (template.isDefault) {
      throw new ApiError(
        400,
        "デフォルトテンプレートは削除できません",
        "BAD_REQUEST",
      );
    }

    await prisma.templatePermission.deleteMany({
      where: { templateId: id },
    });
    await prisma.permissionTemplate.delete({ where: { id } });

    await writeAuditLog({
      userId: session.id,
      action: "template_delete",
      targetTable: "permission_templates",
      targetId: id,
      detail: { name: template.name },
    });

    return apiResponse({ message: "テンプレートを削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
