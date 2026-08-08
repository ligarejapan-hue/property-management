import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { linkOwnerSchema } from "@/lib/validators";
import { hasPermission } from "@/lib/permissions";
import { lockPropertyRow } from "@/lib/property-record-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = linkOwnerSchema.parse(body);

    // Verify property exists
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // Verify owner exists（archived は紐付け対象外）。早期 404 のための事前確認。
    // 実際のレース対策は下の transaction 内 updateMany で行う。
    const owner = await prisma.owner.findUnique({
      where: { id: data.ownerId },
      select: { id: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // archive route との直列化:
    //   transaction 内で owner 行に updateMany を発行し isArchived=false を再確認しつつ
    //   PostgreSQL の行ロックを取得する。これにより archive 側の updateMany と
    //   競合した場合は片方が必ず後続のロック待ちで blocked → 後勝ち側が条件不一致で
    //   失敗する。link 成功時に archive 側の where: { propertyOwners: { none: {} } }
    //   が次回以降の archive を 422 にする。
    //   updatedAt の touch のみで version は変更しない（owner 自体のデータ変更ではないため）。
    const propertyOwner = await prisma.$transaction(async (tx) => {
      const lockRes = await tx.owner.updateMany({
        where: { id: data.ownerId, isArchived: false },
        data: { updatedAt: new Date() },
      });
      if (lockRes.count === 0) {
        // owner が同時にアーカイブされた、または削除された
        throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
      }

      // 親の物件行をロック(書き込み規約+#364 R6)。順序は DM writer 共通の
      // 「Owner→物件親行→子行」に合わせる(逆順は凍結 tx と相互待ちになる)。
      await lockPropertyRow(tx, propertyId);

      // If isPrimary, unset existing primary owner for this property
      if (data.isPrimary) {
        await tx.propertyOwner.updateMany({
          where: { propertyId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      return tx.propertyOwner.create({
        data: {
          propertyId,
          ownerId: data.ownerId,
          relationship: data.relationship,
          isPrimary: data.isPrimary,
        },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "property_owners",
      targetId: propertyOwner.id,
      detail: { propertyId, ownerId: data.ownerId },
    });

    return apiResponse(propertyOwner, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
