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
import {
  findDisplayLevelConflicts,
  describeDisplayLevelConflicts,
} from "@/lib/permission-display-levels";

// ---------- GET /api/admin/users/:id/permissions ----------

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
        name: true,
        role: true,
        userPermissions: {
          select: { id: true, resource: true, action: true, granted: true },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    // Get all templates for the dropdown
    const templates = await prisma.permissionTemplate.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        templatePermissions: {
          select: { resource: true, action: true, granted: true },
        },
      },
      orderBy: { name: "asc" },
    });

    return apiResponse({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
      },
      overrides: user.userPermissions,
      templates,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PUT /api/admin/users/:id/permissions ----------

const updatePermissionsSchema = z.object({
  overrides: z.array(
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

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        userPermissions: {
          select: { resource: true, action: true, granted: true },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, "ユーザーが見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = updatePermissionsSchema.parse(body);

    // 表示レベルは**項目ごとに1つだけ**。複数 granted だと解決側が最も緩いものを
    // 採用するため、「マスク」を選んでも「全表示」が残っていると生値が出続ける。
    // 画面側も排他にしているが、API を直接呼ばれても崩れないようここで弾く。
    const conflicts = findDisplayLevelConflicts(data.overrides);
    if (conflicts.length > 0) {
      throw new ApiError(
        400,
        `表示レベルは項目ごとに1つだけ選べます（${describeDisplayLevelConflicts(conflicts)}）`,
        "VALIDATION_ERROR",
      );
    }

    // 全消し→作り直しは**同一トランザクション**で行う。分けると、作り直しに失敗した
    // ときに個別上書きが消えたままになり、その利用者の権限が黙って変わってしまう。
    await prisma.$transaction(async (tx) => {
      await tx.userPermission.deleteMany({ where: { userId: id } });
      if (data.overrides.length > 0) {
        await tx.userPermission.createMany({
          data: data.overrides.map((o) => ({
            userId: id,
            resource: o.resource,
            action: o.action,
            granted: o.granted,
          })),
        });
      }
    });

    // Log the change
    await prisma.permissionChangeLog.create({
      data: {
        targetUserId: id,
        changedBy: session.id,
        changeType: "override_update",
        oldValue: JSON.parse(JSON.stringify(user.userPermissions)),
        newValue: JSON.parse(JSON.stringify(data.overrides)),
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "permission_update",
      targetTable: "user_permissions",
      targetId: id,
      detail: { overrideCount: data.overrides.length },
    });

    return apiResponse({ message: "権限を更新しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
