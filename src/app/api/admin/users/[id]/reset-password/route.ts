import { NextRequest } from "next/server";
import { z } from "zod";
import { hashSync } from "bcryptjs";
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

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, "パスワードは8文字以上です").max(128),
});

// ---------- POST /api/admin/users/:id/reset-password ----------

export async function POST(
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

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true },
    });

    if (!user) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = resetPasswordSchema.parse(body);

    const passwordHash = hashSync(data.newPassword, 10);

    await prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        mustChangePassword: true,
        loginFailedCount: 0,
        lockedUntil: null,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "password_reset",
      targetTable: "users",
      targetId: id,
      detail: { resetBy: session.id },
    });

    return apiResponse({ message: "パスワードをリセットしました" });
  } catch (error) {
    return handleApiError(error);
  }
}
