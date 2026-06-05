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
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { CASE_STATUS_VALUES } from "@/lib/property-types";

const bulkUpdateSchema = z.object({
  propertyIds: z
    .array(z.string().uuid())
    .min(1, "物件IDを1つ以上指定してください")
    .max(100, "一度に更新できるのは100件までです"),
  updates: z.object({
    caseStatus: z.enum(CASE_STATUS_VALUES).optional(),
    registryStatus: z
      .enum(["unconfirmed", "scheduled", "obtained"])
      .optional(),
    dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
    assignedTo: z.string().uuid().optional().nullable(),
  }),
});

// ---------- POST /api/properties/bulk-update ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { propertyIds, updates } = bulkUpdateSchema.parse(body);

    // Validate that at least one field is being updated
    const updateFields = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(updateFields).length === 0) {
      throw new ApiError(422, "更新フィールドを指定してください", "VALIDATION_ERROR");
    }

    // Build where clause — field_staff can only update their own properties
    const baseWhere: Record<string, unknown> = { id: { in: propertyIds } };
    if (session.role === "field_staff") {
      baseWhere.OR = [
        { createdBy: session.id },
        { assignedTo: session.id },
      ];
    }

    // Fetch current values for change logging.
    // ChangeLog に必要なのは id（targetId / accessibleIds）と、更新され得る
    // 追跡対象列だけ。recordChanges は newValues に含まれる tracked field の
    // oldValues[field] しか参照しないため、bulkUpdateSchema.updates で更新可能な
    // 4 列（caseStatus / registryStatus / dmStatus / assignedTo・いずれも
    // PROPERTY_TRACKED_FIELDS に含まれる）+ id のみを select する。
    // ⚠ bulkUpdateSchema.updates に列を追加した場合はこの select も同期すること
    //   （未 select の更新列は oldValue が誤って null 記録される）。
    const currentProperties = await prisma.property.findMany({
      where: baseWhere,
      select: {
        id: true,
        caseStatus: true,
        registryStatus: true,
        dmStatus: true,
        assignedTo: true,
      },
    });

    if (currentProperties.length === 0) {
      throw new ApiError(404, "対象物件が見つかりません", "NOT_FOUND");
    }

    // Perform bulk update (only on accessible properties)
    const accessibleIds = currentProperties.map((p) => p.id);
    const result = await prisma.property.updateMany({
      where: { id: { in: accessibleIds } },
      data: {
        ...updateFields,
        version: { increment: 1 },
      },
    });

    // Record change logs for each property.
    // 直列 await ループだと対象件数（最大100）分だけ changeLog 書込が逐次往復し
    // レイテンシが積み上がるため、Promise.all で並行ディスパッチする。
    // recordChanges は内部で per-property に createMany + try/catch するため、
    // 失敗粒度（1物件分が失敗しても他は記録される）・記録内容・署名・共通仕様は
    // 従来どおり不変（単一 createMany への統合は失敗粒度を変えるため行わない）。
    await Promise.all(
      currentProperties.map((current) =>
        recordChanges({
          targetTable: "properties",
          targetId: current.id,
          changedBy: session.id,
          oldValues: current as unknown as Record<string, unknown>,
          newValues: updateFields as Record<string, unknown>,
          trackedFields: PROPERTY_TRACKED_FIELDS,
          source: "manual",
        }),
      ),
    );

    await writeAuditLog({
      userId: session.id,
      action: "bulk_update",
      targetTable: "properties",
      detail: {
        propertyIds,
        updatedFields: Object.keys(updateFields),
        count: result.count,
      },
    });

    return apiResponse({
      message: `${result.count} 件の物件を更新しました`,
      updatedCount: result.count,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
