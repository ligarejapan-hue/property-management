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

// ---------- GET /api/admin/users ----------

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const includeInactive =
      request.nextUrl.searchParams.get("includeInactive") === "true";

    const where: Record<string, unknown> = {};
    if (!includeInactive) {
      where.isActive = true;
    }
    if (q.length >= 2) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
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
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      take: 200,
    });

    return apiResponse({ data: users });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/admin/users ----------

const createUserSchema = z.object({
  email: z.string().email("有効なメールアドレスを入力してください"),
  name: z.string().min(1, "名前は必須です"),
  role: z.enum(["admin", "office_staff", "field_staff"]),
  password: z
    .string()
    .min(8, "パスワードは8文字以上です")
    .max(128),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = createUserSchema.parse(body);

    // Check duplicate email
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    });
    if (existing) {
      throw new ApiError(
        409,
        "このメールアドレスは既に使用されています",
        "CONFLICT",
      );
    }

    const passwordHash = hashSync(data.password, 10);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        role: data.role,
        passwordHash,
        mustChangePassword: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "user_create",
      targetTable: "users",
      targetId: user.id,
      detail: { email: user.email, role: user.role },
    });

    return apiResponse(user, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
