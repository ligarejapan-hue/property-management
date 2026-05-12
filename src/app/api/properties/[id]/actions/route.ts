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
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { hasPermission } from "@/lib/permissions";

/**
 * Action definitions — each action validates preconditions,
 * applies field updates, and records audit/change logs.
 *
 * This structure makes it easy to:
 * 1. Add new actions without changing the handler
 * 2. Swap mock logic for real integrations later
 * 3. Reuse from frontend with a single endpoint
 */

const actionSchema = z.object({
  action: z.enum([
    "confirm_investigation",
    "set_dm_send",
    "set_dm_no_send",
    "set_dm_hold",
    "mark_registry_obtained",
    "assign_to_me",
  ]),
  note: z.string().max(500).optional(),
});

interface ActionDef {
  requiredPermission: { resource: string; action: string };
  execute: (params: {
    propertyId: string;
    userId: string;
    note?: string;
  }) => Promise<{ updatedFields: Record<string, unknown>; message: string }>;
}

const ACTIONS: Record<string, ActionDef> = {
  confirm_investigation: {
    requiredPermission: { resource: "property", action: "write" },
    execute: async ({ propertyId }) => {
      return {
        updatedFields: { investigationConfirmedAt: new Date() },
        message: "調査情報を確認しました",
      };
    },
  },

  set_dm_send: {
    requiredPermission: { resource: "property", action: "write" },
    execute: async () => ({
      updatedFields: { dmStatus: "send" },
      message: "DM送付可に設定しました",
    }),
  },

  set_dm_no_send: {
    requiredPermission: { resource: "property", action: "write" },
    execute: async () => ({
      updatedFields: { dmStatus: "no_send" },
      message: "DM送付不可に設定しました",
    }),
  },

  set_dm_hold: {
    requiredPermission: { resource: "property", action: "write" },
    execute: async () => ({
      updatedFields: { dmStatus: "hold" },
      message: "DM未判断に設定しました",
    }),
  },

  mark_registry_obtained: {
    requiredPermission: { resource: "property", action: "write" },
    execute: async () => ({
      updatedFields: { registryStatus: "obtained" },
      message: "登記取得済みに設定しました",
    }),
  },

  assign_to_me: {
    requiredPermission: { resource: "property", action: "write" },
    execute: async ({ userId }) => ({
      updatedFields: { assignedTo: userId },
      message: "自分を担当者に設定しました",
    }),
  },
};

// ---------- POST /api/properties/:id/actions ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    const body = await request.json();
    const { action, note } = actionSchema.parse(body);

    const actionDef = ACTIONS[action];
    if (!actionDef) {
      throw new ApiError(422, "不明なアクションです", "VALIDATION_ERROR");
    }

    // Permission check
    if (
      !hasPermission(
        perms,
        actionDef.requiredPermission.resource,
        actionDef.requiredPermission.action,
      )
    ) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // Fetch current for change log
    const current = await prisma.property.findUnique({
      where: { id: propertyId },
    });
    if (!current) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // Execute action
    const { updatedFields, message } = await actionDef.execute({
      propertyId,
      userId: session.id,
      note,
    });

    // Apply updates with optimistic lock
    const result = await prisma.property.updateMany({
      where: { id: propertyId, version: current.version },
      data: {
        ...updatedFields,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new ApiError(
        409,
        "他のユーザーが先に更新しました。最新データを読み込み直してください。",
        "CONFLICT",
      );
    }

    // Record change log
    await recordChanges({
      targetTable: "properties",
      targetId: propertyId,
      changedBy: session.id,
      oldValues: current as unknown as Record<string, unknown>,
      newValues: updatedFields as Record<string, unknown>,
      trackedFields: PROPERTY_TRACKED_FIELDS,
    });

    // Record audit log
    await writeAuditLog({
      userId: session.id,
      action: `action:${action}`,
      targetTable: "properties",
      targetId: propertyId,
      detail: { action, note, updatedFields: Object.keys(updatedFields) },
    });

    // Return updated property
    const updated = await prisma.property.findUnique({
      where: { id: propertyId },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    return apiResponse({ property: updated, message });
  } catch (error) {
    return handleApiError(error);
  }
}
