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

    // Fetch current values for change logging
    const currentProperties = await prisma.property.findMany({
      where: baseWhere,
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

    // Record change logs for each property
    for (const current of currentProperties) {
      await recordChanges({
        targetTable: "properties",
        targetId: current.id,
        changedBy: session.id,
        oldValues: current as unknown as Record<string, unknown>,
        newValues: updateFields as Record<string, unknown>,
        trackedFields: PROPERTY_TRACKED_FIELDS,
        source: "manual",
      });
    }

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
