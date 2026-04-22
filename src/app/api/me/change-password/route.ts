import { NextRequest } from "next/server";
import { z } from "zod";
import { compare, hashSync } from "bcryptjs";
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

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "現在のパスワードを入力してください"),
    newPassword: z
      .string()
      .min(8, "新しいパスワードは8文字以上で入力してください")
      .max(128, "パスワードが長すぎます"),
    confirmPassword: z.string().min(1, "確認用パスワードを入力してください"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "新しいパスワードと確認用が一致しません",
    path: ["confirmPassword"],
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: "現在のパスワードと同じものは指定できません",
    path: ["newPassword"],
  });

// ---------- POST /api/me/change-password ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // Admin-only per requirement
    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = changePasswordSchema.parse(body);

    const user = await prisma.user.findUnique({
      where: { id: session.id },
      select: { id: true, passwordHash: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    const ok = await compare(data.currentPassword, user.passwordHash);
    if (!ok) {
      throw new ApiError(
        400,
        "現在のパスワードが正しくありません",
        "INVALID_CURRENT_PASSWORD",
      );
    }

    const passwordHash = hashSync(data.newPassword, 10);

    await prisma.user.update({
      where: { id: session.id },
      data: {
        passwordHash,
        mustChangePassword: false,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "password_change_self",
      targetTable: "users",
      targetId: session.id,
      detail: {},
    });

    return apiResponse({ message: "パスワードを変更しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
