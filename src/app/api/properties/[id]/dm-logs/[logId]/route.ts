import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  assertPropertyRecordAccess,
  lockPropertyRecordForWrite,
} from "@/lib/property-record-guard";
import { writeAuditLog } from "@/lib/audit";

// ---------- DELETE /api/properties/:id/dm-logs/:logId ----------
//
// 送付記録の取消(記録ミスの訂正・設計書§2.3)。
//   - 認可: property:write + record scope。tx は lockPropertyRecordForWrite で始める(親→子規約)。
//   - method="sale_dm" の行(売却DMブリッジ)は 409: 売却DM側の draft 状態(sent)と食い違うため。
//   - PR-B(反響列導入)で「undeliverable 反響付き行の削除時に dmUndeliverableAt を
//     親行ロック保持のまま再計算する」処理をこの tx に追加する(設計§2.3)。
//   - 監査 dm_sent_record_delete {logId}。

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; logId: string }> },
) {
  try {
    const { id: propertyId, logId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "送付記録を取り消す権限がありません", "FORBIDDEN");
    }

    await assertPropertyRecordAccess(propertyId, session, "write");

    await prisma.$transaction(async (tx) => {
      await lockPropertyRecordForWrite(tx, propertyId, session);
      const log = await tx.propertyDmLog.findFirst({
        where: { id: logId, propertyId },
        select: { id: true, method: true },
      });
      if (!log) {
        throw new ApiError(404, "送付記録が見つかりません", "NOT_FOUND");
      }
      if (log.method === "sale_dm") {
        throw new ApiError(
          409,
          "売却DMの送付記録はここでは取り消せません。売却DMの画面から操作してください",
          "SALE_DM_LOG",
        );
      }
      await tx.propertyDmLog.delete({ where: { id: logId } });
    });

    await writeAuditLog({
      userId: session.id,
      action: "dm_sent_record_delete",
      targetTable: "property_dm_logs",
      targetId: logId,
      detail: { logId },
    });

    return apiResponse({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
