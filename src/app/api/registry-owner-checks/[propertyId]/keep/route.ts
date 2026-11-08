/**
 * 謄本の名義の確認:「このままでよい」(所有者を編集できる人まで・2026-11-08 発注者決定)。
 * 判断した人と日時を残し、一覧と警告から外す。restoreDm=true なら DM を「送付可」に戻す
 * (画面では最初からチェックが入っている)。新しい謄本が付いたらもう一度比べる。
 */
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
import { canAccessPropertyRecord } from "@/lib/property-access";
import { hasPermission } from "@/lib/permissions";
import { findMissingRegistryOwnerReviewPerm } from "@/lib/registry-owner-check/permissions";
import { keepRegistryOwners } from "@/lib/registry-owner-check/service";

const bodySchema = z.object({
  attachmentId: z.string().uuid(),
  restoreDm: z.boolean(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ propertyId: string }> },
) {
  try {
    const { propertyId } = await context.params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const missing = findMissingRegistryOwnerReviewPerm(perms, "keep");
    if (missing) throw new ApiError(403, missing, "FORBIDDEN");

    const body = bodySchema.parse(await request.json().catch(() => null));
    // ⚠DM を戻すのは物件の項目の書き換え=物件の編集権限も要る(まとめての変更と同じ線)
    if (body.restoreDm && !hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "DM を戻すには物件を編集する権限が要ります", "FORBIDDEN");
    }
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, assignedTo: true, createdBy: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
    }

    const outcome = await keepRegistryOwners({
      session,
      propertyId,
      expectedAttachmentId: body.attachmentId,
      restoreDm: body.restoreDm,
    });
    await writeAuditLog({
      userId: session.id,
      action: "registry_owner_check_keep",
      targetTable: "properties",
      targetId: propertyId,
      detail: { dmRestored: outcome.dmRestored },
    });
    return apiResponse(outcome);
  } catch (error) {
    return handleApiError(error);
  }
}
