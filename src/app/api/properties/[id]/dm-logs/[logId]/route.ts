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
//   - undeliverable 反響付き行の削除時は、親行ロック保持のまま残数(宛先不明の他ログ+
//     returned_undeliverable の sent ドラフト)を数え、ゼロなら dmUndeliverableAt を
//     自動解除する(PR-B・設計§2.3。dmStatus は人の判断で戻す=clear-dm-undeliverable と同方針)。
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
        select: { id: true, method: true, batchId: true, reactionStatus: true },
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
      // 一括確定で作られた行の単独削除は不可(@codex #364 R3): 控えは確定済みのまま
      // 履歴だけが欠け、確定APIは ALREADY_CONFIRMED で二度と作り直せない(送付回数・
      // 再送除外も「未送付」扱いに化ける)。取り消しはバッチ単位の機能として別途設ける。
      if (log.batchId) {
        throw new ApiError(
          409,
          "一括確定で記録された送付はここでは取り消せません",
          "BATCH_LOG",
        );
      }
      // 「拒否」が付いた記録の取消は管理者のみ(発注者指示 2026-08-17)。削除を許すと
      // 「拒否→変更は管理者のみ」(reaction route)の縛りが素通りになる(消して記録し
      // 直せば拒否を外せる)。親行ロック保持中に読んだ値で判定。
      if (log.reactionStatus === "refused" && session.role !== "admin") {
        throw new ApiError(
          403,
          "「拒否」が記録された送付記録を取り消せるのは管理者のみです",
          "REFUSED_DELETE_ADMIN_ONLY",
        );
      }
      await tx.propertyDmLog.delete({ where: { id: logId } });

      // 宛先不明の反響が付いた行を消したら、物件の自動フラグを再計算する(PR-B)。
      // 残数=自分以外の宛先不明ログ+returned_undeliverable の sent ドラフト。ゼロなら
      // dmUndeliverableAt のみ解除(dmStatus は人の判断で戻す)。親行ロックは保持中。
      if (log.reactionStatus === "undeliverable") {
        const [logCount, draftCount] = await Promise.all([
          tx.propertyDmLog.count({
            where: {
              propertyId,
              reactionStatus: "undeliverable",
              id: { not: logId },
            },
          }),
          tx.dmRecipientDraft.count({
            where: {
              propertyId,
              status: "sent",
              deliveryStatus: "returned_undeliverable",
            },
          }),
        ]);
        if (logCount + draftCount === 0) {
          await tx.property.update({
            where: { id: propertyId },
            data: { dmUndeliverableAt: null },
          });
        }
      }
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
