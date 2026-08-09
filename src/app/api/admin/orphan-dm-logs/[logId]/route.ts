import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { isRealCalendarDate } from "@/lib/calendar-date";
import {
  REACTION_STATUSES,
  isTerminalReaction,
  applyManualReaction,
} from "@/lib/dm-reaction/core";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";

// ---------- PATCH / DELETE /api/admin/orphan-dm-logs/:logId ----------
//
// 孤児記録(propertyId=null)の反響訂正・取消(設計§2.4・R51 P2)。対象外は 404。
//   - ゲート: user_management:read + property:write(反響・記録の書込と同じ)。
//   - PATCH: 手動反響 PATCH と同じ検証+applyManualReaction。terminal を書くときは
//     Owner FOR UPDATE 先行(親行ロックは親が無いので無し=R47)。物件連動なし。
//     ブリッジ再導出も無し(物件削除で draft も消えている)。
//   - DELETE: batchId/sale_dm 由来でも孤児は削除可(他に復元経路が無いため。
//     設計の「訂正経路を必ず用意する」が優先)。
//   - 監査は既存 action(dm_reaction_update / dm_sent_record_delete)+detail orphan:true。

const reactionSchema = z.object({
  status: z.enum(REACTION_STATUSES),
  reactedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, "実在する日付を指定してください")
    .optional(),
  note: z.string().max(500).optional(),
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

async function requireOrphanAdmin(): Promise<{ id: string; role: string }> {
  const session = await getApiSession();
  const permissions = await getUserPermissions(session.id);
  if (!hasPermission(permissions, "user_management", "read")) {
    throw new ApiError(403, "管理者権限がありません", "FORBIDDEN");
  }
  if (!hasPermission(permissions, "property", "write")) {
    throw new ApiError(403, "記録を更新する権限がありません", "FORBIDDEN");
  }
  return session;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ logId: string }> },
) {
  try {
    const { logId } = await params;
    const session = await requireOrphanAdmin();
    const body = reactionSchema.parse(await request.json());

    if (body.reactedAt) {
      const todayJst = new Date(Date.now() + JST_OFFSET_MS)
        .toISOString()
        .slice(0, 10);
      if (body.reactedAt > todayJst) {
        throw new ApiError(
          400,
          "反響日に未来の日付は指定できません",
          "REACTED_AT_IN_FUTURE",
        );
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const rawTx = tx as unknown as RawTx;
      // 孤児行のみ受理(propertyId 付きは通常経路 /api/properties/[id]/... で扱う)。
      const pre = await tx.propertyDmLog.findFirst({
        where: { id: logId, propertyId: null },
        select: {
          id: true,
          ownerId: true,
          logOwners: { select: { ownerId: true } },
        },
      });
      if (!pre) {
        throw new ApiError(404, "孤児の送付記録が見つかりません", "NOT_FOUND");
      }

      // terminal を書くときは Owner 先頭 FOR UPDATE(R47)。親行ロックは親が無いので無し。
      if (isTerminalReaction(body.status)) {
        const ownerIds = [
          ...(pre.ownerId ? [pre.ownerId] : []),
          ...pre.logOwners.map((o) => o.ownerId),
        ];
        await lockOwnersForUpdate(rawTx, ownerIds);
      }

      const fresh = await tx.propertyDmLog.findFirst({
        where: { id: logId, propertyId: null },
        select: {
          id: true,
          reactionStatus: true,
          reactedAt: true,
          reactionNote: true,
          reactionSource: true,
          manualReactionShadow: true,
        },
      });
      if (!fresh) {
        throw new ApiError(404, "孤児の送付記録が見つかりません", "NOT_FOUND");
      }

      const next = applyManualReaction(fresh, {
        status: body.status,
        reactedAt: body.reactedAt
          ? new Date(`${body.reactedAt}T00:00:00Z`)
          : null,
        note: body.note?.trim() ? body.note.trim() : null,
      });
      await tx.propertyDmLog.update({
        where: { id: logId },
        data: {
          reactionStatus: next.reactionStatus,
          reactedAt: next.reactedAt,
          reactionNote: next.reactionNote,
          reactionSource: next.reactionSource,
          manualReactionShadow: Prisma.DbNull,
        },
      });
      return next;
    });

    await writeAuditLog({
      userId: session.id,
      action: "dm_reaction_update",
      targetTable: "property_dm_logs",
      targetId: logId,
      detail: {
        logId,
        status: body.status,
        reactedAt: body.reactedAt ?? null,
        orphan: true,
      },
    });

    return apiResponse({
      id: logId,
      reactionStatus: result.reactionStatus,
      reactedAt: result.reactedAt,
      reactionSource: result.reactionSource,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ logId: string }> },
) {
  try {
    const { logId } = await params;
    const session = await requireOrphanAdmin();

    await prisma.$transaction(async (tx) => {
      const log = await tx.propertyDmLog.findFirst({
        where: { id: logId, propertyId: null },
        select: { id: true },
      });
      if (!log) {
        throw new ApiError(404, "孤児の送付記録が見つかりません", "NOT_FOUND");
      }
      await tx.propertyDmLog.delete({ where: { id: logId } });
    });

    await writeAuditLog({
      userId: session.id,
      action: "dm_sent_record_delete",
      targetTable: "property_dm_logs",
      targetId: logId,
      detail: { logId, orphan: true },
    });

    return apiResponse({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
