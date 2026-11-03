import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { assertPropertyRecordAccess, lockPropertyRecordForWrite } from "@/lib/property-record-guard";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import { parseScopeInput } from "@/lib/attachments/deal-scope";

// ---------- PUT /api/properties/:id/attachments/deal-scope ----------
// 添付がどの取引の書類かを決める(買取再販の仕入/売却・2026-11-04 発注者 案A)。
// body: { items: [{ attachmentId, scope }] }  scope = "common"(共通) | 取引の id | null(未区分に戻す)
// 1件の選び直しも「推定どおりに確定」(まとめて)もここを通す。

const MAX_ITEMS = 500;
const bodySchema = z.object({
  items: z
    .array(z.object({ attachmentId: z.string().uuid(), scope: z.string().max(64).nullable() }))
    .min(1)
    .max(MAX_ITEMS),
});

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    // 物件を編集できて、取引を見られる人だけ(取引の一覧が見えない人に取引を選ばせない)。
    if (!hasPermission(perms, "property", "write") || !hasPermission(perms, "deal", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    await assertPropertyRecordAccess(propertyId, session, "write");

    assertImportJsonBodySize(request, 64 * 1024);
    const body = bodySchema.parse(await request.json());
    const parsed = body.items.map((it) => {
      const columns = parseScopeInput(it.scope);
      if (!columns) throw new ApiError(422, "取引の指定が読めません", "VALIDATION_ERROR");
      return { attachmentId: it.attachmentId.toLowerCase(), columns };
    });
    const ids = [...new Set(parsed.map((p) => p.attachmentId))];
    if (ids.length !== parsed.length) throw new ApiError(422, "同じ添付が2回入っています", "VALIDATION_ERROR");

    const counts = await prisma.$transaction(async (tx) => {
      // 物件配下の書き換えは親を先にロック(担当の範囲もロックした行で確かめる)。
      await lockPropertyRecordForWrite(tx, propertyId, session);
      const found = await tx.attachment.findMany({
        where: { id: { in: ids }, targetType: "property", targetId: propertyId, isDeleted: false },
        select: { id: true },
      });
      if (found.length !== ids.length) throw new ApiError(404, "添付ファイルが見つかりません", "NOT_FOUND");
      const dealIds = [...new Set(parsed.map((p) => p.columns.dealId).filter((d): d is string => d !== null))];
      if (dealIds.length > 0) {
        const deals = await tx.deal.findMany({ where: { id: { in: dealIds }, propertyId }, select: { id: true } });
        if (deals.length !== dealIds.length) throw new ApiError(422, "この物件の取引ではありません", "VALIDATION_ERROR");
      }
      const c = { deal: 0, common: 0, unset: 0 };
      for (const p of parsed) {
        await tx.attachment.update({ where: { id: p.attachmentId }, data: p.columns });
        if (p.columns.dealId) c.deal++;
        else if (p.columns.dealCommon) c.common++;
        else c.unset++;
      }
      return c;
    });

    // ⚠監査にはファイル名を出さない(件数と物件 ID だけ)。
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "attachments",
      targetId: propertyId,
      detail: { propertyId, updatedCount: parsed.length, toDeal: counts.deal, toCommon: counts.common, toUnset: counts.unset },
    });

    return apiResponse({ updated: parsed.length });
  } catch (error) {
    return handleApiError(error);
  }
}
