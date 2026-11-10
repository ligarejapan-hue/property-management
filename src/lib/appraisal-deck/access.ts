/**
 * 「査定のご報告」(appraisal_decks)を見る・直す権限(2026-11-10)。
 *
 * 資料は査定報告書(依頼者の氏名が載る・OWNER_PII_DOCUMENT_TYPES の report)から作るので、
 * **査定報告書を開ける人と同じ範囲**(canOpenReferralDocument)に絞る。そのうえで物件の閲覧/編集の
 * 権限と、担当分しか見られない役割のスコープ(canAccessPropertyRecord)を確かめる。
 * ⚠画面だけでなく API の全経路でこれを通す(CLAUDE.md §19)。
 */
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { canOpenReferralDocument } from "@/lib/uploads-authorization";
import type { PermissionEntry } from "@/lib/api-helpers";

export type AppraisalDeckAccessMode = "read" | "write";

export function canUseAppraisalDecks(permissions: PermissionEntry[], mode: AppraisalDeckAccessMode): boolean {
  if (!hasPermission(permissions, "property", mode)) return false;
  return canOpenReferralDocument(permissions);
}

/** 物件があり、この人がその物件と資料を扱えることを確かめる。だめなら ApiError を投げる。 */
export async function assertAppraisalDeckAccess(
  session: { id: string; role: string },
  permissions: PermissionEntry[],
  propertyId: string,
  mode: AppraisalDeckAccessMode,
): Promise<{ id: string; isArchived: boolean }> {
  if (!canUseAppraisalDecks(permissions, mode)) {
    throw new ApiError(403, "査定のご報告を扱う権限がありません", "FORBIDDEN");
  }
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, createdBy: true, assignedTo: true, isArchived: true },
  });
  if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
  }
  return { id: property.id, isArchived: property.isArchived };
}
