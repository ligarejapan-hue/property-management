import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";

/**
 * ライブラリからの削除は管理者のみ(設計 §2.7・sale-dm-settings と同じ門 user_management:write)。
 * どこかのLP型が参照していれば 409(参照を外してから)。実ファイルの削除は best-effort。
 *
 * 存在確認・参照カウント・論理削除は1つの tx にまとめ、対象行を FOR UPDATE でロックしてから読む。
 * この route はロック順序のうち dm_lp_assets だけを掴む一貫した部分列(media PUT の
 * dm_lp_variants → properties → dm_lp_assets と同じ並びの末尾)。ロックせずに3クエリへ分けると、
 * media PUT が「削除済みでない」ことを確認してから行を作るまでの間に、この DELETE が
 * 割り込んで確定してしまい、削除済み(実ファイルも失った)アセットを指す行が残ってしまう。
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "user_management", "write")) {
      throw new ApiError(403, "写真の削除は管理者のみ行えます", "FORBIDDEN");
    }
    const { assetId } = await params;
    const storageKey = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_assets WHERE id = ${assetId}::uuid FOR UPDATE`;
      const asset = await tx.dmLpAsset.findUnique({ where: { id: assetId }, select: { id: true, storageKey: true, deletedAt: true } });
      if (!asset || asset.deletedAt) throw new ApiError(404, "写真が見つかりません", "ASSET_NOT_FOUND");
      const referenced = await tx.dmLpVariantMedia.count({ where: { assetId } });
      if (referenced > 0) {
        throw new ApiError(409, "この写真はLP型で使われています。先にLP型から外してください", "REFERENCED");
      }
      await tx.dmLpAsset.update({ where: { id: assetId }, data: { deletedAt: new Date() } });
      return asset.storageKey;
    });
    try { await getStorage().delete(storageKey); } catch { /* best-effort: 論理削除が正 */ }
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
