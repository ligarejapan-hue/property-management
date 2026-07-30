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
  assertPropertyRecordAccess,
  lockPropertyRecordForWrite,
  propertyRecordScopeFilter,
} from "@/lib/property-record-guard";

const updateNextActionSchema = z.object({
  isCompleted: z.boolean().optional(),
  assignedTo: z.string().uuid().optional(),
  scheduledAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  actionType: z.string().max(50).optional().nullable(),
  content: z.string().min(1, "内容は必須です").max(1000, "内容は1000文字以内です").optional(),
});

// ---------- PATCH /api/properties/:id/next-actions/:actionId ----------

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; actionId: string }> },
) {
  try {
    const { id: propertyId, actionId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.nextAction.findUnique({
      where: { id: actionId },
    });
    if (!existing || existing.propertyId !== propertyId) {
      throw new ApiError(404, "アクションが見つかりません", "NOT_FOUND");
    }

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    // 対応予定は自由記述1000文字で顧客の事情が入るため、担当外には出さない。
    await assertPropertyRecordAccess(propertyId, session, "write");

    const body = await request.json();
    const data = updateNextActionSchema.parse(body);

    const updateData: Record<string, unknown> = {};
    if (data.content !== undefined) updateData.content = data.content;
    if (data.assignedTo !== undefined) updateData.assignedTo = data.assignedTo;
    if (data.actionType !== undefined) updateData.actionType = data.actionType;
    if (data.scheduledAt !== undefined)
      updateData.scheduledAt = new Date(data.scheduledAt);
    if (data.isCompleted !== undefined) {
      updateData.isCompleted = data.isCompleted;
      updateData.completedAt = data.isCompleted ? new Date() : null;
    }

    // ⚠**書き込みはスコープを where に畳み込んで原子化する**（@codex #338 P2）。
    // 上のガードは受付時点の判定なので、判定から更新までの間に担当が付け替わると
    // 担当外の予定を書き換えてしまう。0 件 = その間に外れた（or 別物件の予定）→ 403。
    // ⚠**更新と読み直しは同一トランザクション**（@codex #338 R6・候補判定と同じ）。
    // updateMany の行ロックは文の終わりで解放されるので、分けたままだと同じ予定を
    // 2人が同時に触ったとき、相手の値を返す／相手が消していれば読み直しで 500
    // （しかも自分の更新は済んでいるのに監査が残らない）。
    const scope = propertyRecordScopeFilter(session);
    const updated = await prisma.$transaction(async (tx) => {
      // 親の物件行を先にロックする（@codex #338 R7・全書き込み共通）。
      await lockPropertyRecordForWrite(tx, propertyId, session);
      const applied = await tx.nextAction.updateMany({
        where: { id: actionId, propertyId, ...(scope ? { property: scope } : {}) },
        data: updateData,
      });
      if (applied.count === 0) {
        throw new ApiError(
          403,
          "この物件を操作する権限がありません",
          "FORBIDDEN",
        );
      }
      return tx.nextAction.findUniqueOrThrow({
        where: { id: actionId },
        include: {
          assignee: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
        },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: data.isCompleted ? "complete" : "update",
      targetTable: "next_actions",
      targetId: actionId,
      detail: { propertyId, updatedFields: Object.keys(data) },
    });

    return apiResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/properties/:id/next-actions/:actionId ----------

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; actionId: string }> },
) {
  try {
    const { id: propertyId, actionId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.nextAction.findUnique({
      where: { id: actionId },
    });
    if (!existing || existing.propertyId !== propertyId) {
      throw new ApiError(404, "アクションが見つかりません", "NOT_FOUND");
    }

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    // 対応予定は自由記述1000文字で顧客の事情が入るため、担当外には出さない。
    await assertPropertyRecordAccess(propertyId, session, "write");

    // ⚠削除も where にスコープを畳み込んで原子化する（@codex #338 P2・上と同じ理由）。
    // ⚠親の物件行を先にロックする（@codex #338 R7・全書き込み共通）。述語だけでは
    // 親行がロックされないため tx にして順序を「親 → 子」に揃える。
    const scope = propertyRecordScopeFilter(session);
    await prisma.$transaction(async (tx) => {
      await lockPropertyRecordForWrite(tx, propertyId, session);
      const removed = await tx.nextAction.deleteMany({
        where: { id: actionId, propertyId, ...(scope ? { property: scope } : {}) },
      });
      if (removed.count === 0) {
        throw new ApiError(
          403,
          "この物件を操作する権限がありません",
          "FORBIDDEN",
        );
      }
    });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "next_actions",
      targetId: actionId,
      detail: { propertyId },
    });

    return apiResponse({ message: "削除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
