import { NextRequest } from "next/server";
import { z } from "zod";
import { compare, hashSync } from "bcryptjs";
import prisma from "@/lib/prisma";
import { getApiSession, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { reserveSelfPasswordAttempt } from "@/lib/self-password-attempts";

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
    // 自分のパスワードは全員が変えられる(発注者決定 2026-10-15・以前は管理者だけ)。
    // 変えられるのは本人(session.id)の分だけで、今のパスワードの照合が必須。
    // 他人のパスワードの変更は管理者用の別 API(利用者管理の書き込み権限)のまま。
    const session = await getApiSession();

    const body = await request.json();
    const data = changePasswordSchema.parse(body);

    const user = await prisma.user.findUnique({
      where: { id: session.id },
      select: { id: true, passwordHash: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    // 照合の前に1回分を予約する(ログインと同じ「5回で30分ロック」の数え・同時要求でも超えない)。
    if (!(await reserveSelfPasswordAttempt(prisma, session.id, new Date()))) {
      throw new ApiError(
        429,
        "間違いが続いたため、しばらく変更できません。30分ほどおいてからお試しください",
        "TOO_MANY_ATTEMPTS",
      );
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
        // 当たったら予約分も含めて数えを戻す(ログイン成功時と同じ)。
        loginFailedCount: 0,
        lockedUntil: null,
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
