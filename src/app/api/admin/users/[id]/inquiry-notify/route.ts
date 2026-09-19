import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  parseJsonBody,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";

// 査定申込の通知メール(利用者ごと)。管理者が「この人は通知を受け取る」+ 宛先を設定する画面。
// 門は admin/users/[id]/route.ts と同じ(user_management:read=GET / write=PUT)。

const noStore = { headers: { "Cache-Control": "no-store" } };

type NotifyRow = {
  id: string;
  email: string;
  inquiryNotifyEnabled: boolean;
  inquiryNotifyEmail: string | null;
};

async function buildResponseData(row: NotifyRow) {
  // 実際にこの人へ通知が届くかどうか(売却DMを使う権限が無ければ、enabled=true でも届かない)。
  const access = await checkSaleDmAccessFor(row.id);
  return {
    enabled: row.inquiryNotifyEnabled,
    email: row.inquiryNotifyEmail,
    loginEmail: row.email,
    canUseSaleDm: access.ok,
  };
}

// ---------- GET /api/admin/users/:id/inquiry-notify ----------

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
      select: { id: true, email: true, inquiryNotifyEnabled: true, inquiryNotifyEmail: true },
    });

    if (!user) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    return NextResponse.json({ data: await buildResponseData(user) }, noStore);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PUT /api/admin/users/:id/inquiry-notify ----------

// email: 通常のメール形式 / 空文字(クリア=ログインの email を使う) / null(空文字と同じ扱い)。
const emailOrEmptyOrNull = z
  .string()
  .trim()
  .max(254)
  .nullable()
  .refine((v) => v === null || v === "" || z.string().email().safeParse(v).success, {
    message: "メールアドレスの形式が正しくありません",
  });

const putSchema = z.object({
  enabled: z.boolean().optional(),
  email: emailOrEmptyOrNull.optional(),
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

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, inquiryNotifyEnabled: true, inquiryNotifyEmail: true },
    });

    if (!existing) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    const body = putSchema.parse(await parseJsonBody(request));

    const updateData: Record<string, unknown> = {};
    // 監査 detail に残すのはフィールド「名」だけ(実際に来たものだけ・値=メールアドレスは残さない)。
    const changedFields: string[] = [];

    if (body.enabled !== undefined) {
      updateData.inquiryNotifyEnabled = body.enabled;
      changedFields.push("inquiryNotifyEnabled");
    }
    if (body.email !== undefined) {
      const normalized = body.email === null || body.email === "" ? null : body.email;
      updateData.inquiryNotifyEmail = normalized;
      changedFields.push("inquiryNotifyEmail");
    }

    const updated =
      changedFields.length > 0
        ? await prisma.user.update({
            where: { id },
            data: updateData,
            select: { id: true, email: true, inquiryNotifyEnabled: true, inquiryNotifyEmail: true },
          })
        : existing;

    if (changedFields.length > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "user_update",
        targetTable: "users",
        targetId: id,
        detail: { changedFields },
      });
    }

    return NextResponse.json({ data: await buildResponseData(updated) }, noStore);
  } catch (error) {
    return handleApiError(error);
  }
}
