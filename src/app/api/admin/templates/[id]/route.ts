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

    // 表示レベル（非表示/マスク/一部表示/閲覧のみ/全表示/編集可）は**項目ごとに1つだけ**。
    // 複数 granted だと解決側（getOwnerDisplayConfig）が**最も緩いものを採用**するため、
    // 「マスク」を付けても「全表示」の行が残っていると生値が出続ける＝設定した人の
    // 意図と実際の見え方が食い違う。画面側も排他にしているが、API を直接呼ばれても
    // 崩れないようここで弾く（保存前に検証する＝壊れた組み合わせを保存しない）。
    const conflicts = findDisplayLevelConflicts(data.permissions);
    if (conflicts.length > 0) {
      throw new ApiError(
        400,
        `表示レベルは項目ごとに1つだけ選べます（${describeDisplayLevelConflicts(conflicts)}）`,
        "VALIDATION_ERROR",
      );
    }

    // Check name uniqueness (excluding self)
    const nameConflict = await prisma.permissionTemplate.findFirst({
      where: { name: data.name, id: { not: id } },
    });
    if (nameConflict) {
      throw new ApiError(409, "同名のテンプレートが既に存在します", "CONFLICT");
    }

    // 全消し→作り直しは**同一トランザクション**で行う。分けると、作り直しに失敗した
    // ときにテンプレートの権限が空のまま残り、そのテンプレートを使う全員が一斉に
    // 権限を失う（fail-safe 方向ではあるが業務は止まる）。
    const updated = await prisma.$transaction(async (tx) => {
      await tx.templatePermission.deleteMany({ where: { templateId: id } });
      return tx.permissionTemplate.update({
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

    // 権限行の削除とテンプレート本体の削除は同一トランザクションで。
    // 分けると、後段が失敗したときに**権限だけ空になったテンプレート**が残り、
    // それを使っている利用者が一斉に権限を失う。
    await prisma.$transaction(async (tx) => {
      await tx.templatePermission.deleteMany({ where: { templateId: id } });
      await tx.permissionTemplate.delete({ where: { id } });
    });

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
