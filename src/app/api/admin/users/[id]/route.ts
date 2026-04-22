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

// ---------- GET /api/admin/users/:id ----------

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

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        loginFailedCount: true,
        lockedUntil: true,
        mustChangePassword: true,
        totpEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    return apiResponse(user);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/admin/users/:id ----------

const updateUserSchema = z.object({
  name: z.string().min(1, "名前は必須です").optional(),
  email: z.string().email("メールアドレスの形式が正しくありません").optional(),
  role: z.enum(["admin", "office_staff", "field_staff"]).optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
  // Unlock: reset loginFailedCount and lockedUntil
  unlock: z.boolean().optional(),
});

export async function PATCH(
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

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (!existing) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    // Prevent deactivating own account
    if (id === session.id) {
      const body = await request.clone().json();
      if (body.isActive === false) {
        throw new ApiError(400, "自分自身を無効化できません", "SELF_DEACTIVATE");
      }
    }

    const body = await request.json();
    const data = updateUserSchema.parse(body);

    // Check email uniqueness if changed
    if (data.email && data.email !== existing.email) {
      const dup = await prisma.user.findUnique({
        where: { email: data.email },
        select: { id: true },
      });
      if (dup) {
        throw new ApiError(409, "このメールアドレスは既に使用されています", "CONFLICT");
      }
    }

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.mustChangePassword !== undefined)
      updateData.mustChangePassword = data.mustChangePassword;
    if (data.unlock) {
      updateData.loginFailedCount = 0;
      updateData.lockedUntil = null;
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        loginFailedCount: true,
        lockedUntil: true,
        mustChangePassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Log permission change if role changed
    if (data.role && data.role !== existing.role) {
      await prisma.permissionChangeLog.create({
        data: {
          targetUserId: id,
          changedBy: session.id,
          changeType: "role_change",
          oldValue: { role: existing.role },
          newValue: { role: data.role },
        },
      });
    }

    const changedFields = Object.keys(updateData);
    await writeAuditLog({
      userId: session.id,
      action: data.isActive === false
        ? "user_deactivate"
        : data.isActive === true && !existing.isActive
          ? "user_reactivate"
          : "user_update",
      targetTable: "users",
      targetId: id,
      detail: { changedFields },
    });

    return apiResponse(user);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/admin/users/:id ----------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    if (id === session.id) {
      throw new ApiError(400, "自分自身を削除できません", "SELF_DELETE");
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (!target) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    if (target.role === "admin") {
      const remainingAdmins = await prisma.user.count({
        where: { role: "admin", isActive: true, id: { not: id } },
      });
      if (remainingAdmins === 0) {
        throw new ApiError(
          400,
          "最後の管理者は削除できません",
          "LAST_ADMIN",
        );
      }
    }

    try {
      await prisma.user.delete({ where: { id } });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2003" || code === "P2014") {
        throw new ApiError(
          409,
          "このユーザーは他のデータから参照されているため削除できません。無効化をご利用ください。",
          "FK_CONSTRAINT",
        );
      }
      throw err;
    }

    await writeAuditLog({
      userId: session.id,
      action: "user_delete",
      targetTable: "users",
      targetId: id,
      detail: { email: target.email, role: target.role },
    });

    return apiResponse({ message: "ユーザーを削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
