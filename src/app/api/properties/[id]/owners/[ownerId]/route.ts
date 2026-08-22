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
import { recordChanges } from "@/lib/change-log";
import { hasPermission } from "@/lib/permissions";
import { lockPropertyRow } from "@/lib/property-record-guard";

// 物件×所有者単位のメモ更新（PropertyOwner.note）。
// Owner.note (所有者全体のメモ) と混同しないこと。
const patchPropertyOwnerSchema = z.object({
  note: z.string().nullable().optional(),
  relationship: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ownerId: string }> },
) {
  try {
    const { id: propertyId, ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = patchPropertyOwnerSchema.parse(body);

    const existing = await prisma.propertyOwner.findUnique({
      where: { propertyId_ownerId: { propertyId, ownerId } },
    });
    if (!existing) {
      throw new ApiError(
        404,
        "物件と所有者の紐付けが見つかりません",
        "NOT_FOUND",
      );
    }

    const updateData: Record<string, unknown> = {};
    if (data.note !== undefined) updateData.note = data.note;
    if (data.relationship !== undefined)
      updateData.relationship = data.relationship;
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;

    // ⚠親の物件行を先にロックする(書き込み規約+#364 R8): 素の update は DM 控えの
    // 凍結 tx(親行 FOR SHARE 保持で代表・グループを検証)と直列化されず、変更前の
    // 代表/続柄で描いた古いCSVがそのまま凍結される。
    const updated = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, propertyId);
      // isPrimary を立てる場合は同一物件の他リンクを下ろす
      if (data.isPrimary === true) {
        await tx.propertyOwner.updateMany({
          where: { propertyId, isPrimary: true, NOT: { id: existing.id } },
          data: { isPrimary: false },
        });
      }
      return tx.propertyOwner.update({
        where: { id: existing.id },
        data: updateData,
      });
    });

    await recordChanges({
      targetTable: "property_owners",
      targetId: existing.id,
      changedBy: session.id,
      oldValues: {
        note: existing.note,
        relationship: existing.relationship,
        isPrimary: existing.isPrimary,
      },
      newValues: updateData,
      trackedFields: ["note", "relationship", "isPrimary"],
    });

    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "property_owners",
      targetId: existing.id,
      detail: { propertyId, ownerId, fields: Object.keys(updateData) },
    });

    return apiResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; ownerId: string }> },
) {
  try {
    const { id: propertyId, ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    // 発注者判断 2026-08-21:「削除と付け替えは別のボタンにしてほしい。
    // **事務担当は付け替えだけに**」⇒ **外す(リンク削除)は管理者だけ**。
    // ⚠このリポには role を直接見る仕組みが無い。既存の管理者向け route
    // (誤紐づき修正 = /api/admin/owners/correction/mislink) が
    // `user_management:read` を管理者の代理鍵として使っているので **同じ鍵に揃える**
    // (判定基準を2種類作らない)。本番実測: 事務担当用テンプレはこの鍵を持たない。
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(
        403,
        "所有者を物件から外すには管理者権限が必要です",
        "FORBIDDEN",
      );
    }
    // ⚠**物件の編集権限も要る**(@codex #400 R1 P1)。付け替え(mislink)は
    // property:write を要求している。紐付けを**壊す側だけ緩い**のは筋が通らず、
    // 権限は個別に上書きできるため「user_management:read + owner:write はあるが
    // property:write は無い」組み合わせが実際に作れてしまう。
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件更新の権限がありません", "FORBIDDEN");
    }

    // 早期の存在確認 (404 を返すための下見)。⚠**これは判断の根拠にしない**——
    // ロックを取る前の値なので、下の tx 内で必ず読み直す。
    const preview = await prisma.propertyOwner.findUnique({
      where: {
        propertyId_ownerId: {
          propertyId,
          ownerId,
        },
      },
    });

    if (!preview) {
      throw new ApiError(
        404,
        "物件と所有者の紐付けが見つかりません",
        "NOT_FOUND",
      );
    }

    // Delete the link。⚠親の物件行を先にロックする(書き込み規約+#364 R6):
    // 素の delete は DM 控えの凍結 tx(親行 FOR SHARE 保持で宛先資格を検証)と直列化されず、
    // 解除直前のリンクを読んだ古いCSVがそのまま凍結・配布される。
    //
    // ⚠**ロックを取ってから読み直す**(@codex #400 R1 P1)。付け替え(relink)は
    // **同じ行の ownerId を書き換える**ため、下見で得た行 id をそのまま消すと、
    // その隙間に付け替えが入ったとき**確認画面で名前を見せた人とは別の人**の
    // 紐付けを消してしまう。読み直して「まだこの所有者の行か」を確かめる。
    const propertyOwner = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, propertyId);
      const current = await tx.propertyOwner.findUnique({
        where: {
          propertyId_ownerId: {
            propertyId,
            ownerId,
          },
        },
      });
      if (!current) {
        throw new ApiError(
          409,
          "他のユーザーが先にこの紐付けを変更しました。画面を再読み込みしてください。",
          "CONFLICT",
        );
      }
      await tx.propertyOwner.delete({
        where: { id: current.id },
      });
      return current;
    });

    // Record change log for the unlink
    // ⚠記録する before は**読み直した値**。下見の値だと、直前に変わった
    // relationship / isPrimary を取り違えて残す。
    await recordChanges({
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      changedBy: session.id,
      oldValues: {
        propertyId: propertyOwner.propertyId,
        ownerId: propertyOwner.ownerId,
        relationship: propertyOwner.relationship,
        isPrimary: propertyOwner.isPrimary,
      },
      newValues: {},
      trackedFields: ["propertyId", "ownerId", "relationship", "isPrimary"],
    });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      detail: { propertyId, ownerId },
    });

    return apiResponse({ message: "紐付けを解除しました" });
  } catch (error) {
    return handleApiError(error);
  }
}
