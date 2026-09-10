import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";

/**
 * ライブラリからの削除は管理者のみ(設計 §2.7・sale-dm-settings と同じ門 user_management:write)。
 * どこかのLP型が参照していれば 409(参照を外してから)。実ファイルの削除は best-effort。
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "写真の削除は管理者のみ行えます", "FORBIDDEN");
    }
    const { assetId } = await params;
    const asset = await prisma.dmLpAsset.findUnique({ where: { id: assetId }, select: { id: true, storageKey: true, deletedAt: true } });
    if (!asset || asset.deletedAt) throw new ApiError(404, "写真が見つかりません", "ASSET_NOT_FOUND");
    const referenced = await prisma.dmLpVariantMedia.count({ where: { assetId } });
    if (referenced > 0) {
      throw new ApiError(409, "この写真はLP型で使われています。先にLP型から外してください", "REFERENCED");
    }
    await prisma.dmLpAsset.update({ where: { id: assetId }, data: { deletedAt: new Date() } });
    try { await getStorage().delete(asset.storageKey); } catch { /* best-effort: 論理削除が正 */ }
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_asset_delete",
      targetTable: "dm_lp_assets",
      targetId: assetId,
      detail: { deletedAt: new Date().toISOString() },
    });
    return NextResponse.json({ deleted: assetId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
