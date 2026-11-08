/**
 * 謄本の名義の確認: 1物件を開いたときの中身(2026-11-08)。
 *
 *   GET … システムの所有者と謄本の名義を並べて返す。「謄本の名義に直す」で外れる人・
 *         加わる人も返す(確認画面にそのまま出す)。**何も保存しない**(閲覧の記録だけ)。
 *
 * ⚠謄本PDFを直接読むので、`/uploads` と同じ非PIIの閲覧記録を残す(registry_pdf_preview)。
 * ⚠住所は、所有者の住所を伏せずに見られる人にだけ返す。
 */
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
import { canAccessPropertyRecord } from "@/lib/property-access";
import { getOwnerFieldLevel, isMaskFreeLevel } from "@/lib/permissions";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { loadLatestRegistryText, SUPPORTED_CERTIFICATE_TYPE } from "@/lib/registry-owner-apply/apply";
import { registryDisplayName } from "@/lib/attachments/registry-display-name";
import { findMissingRegistryOwnerReviewPerm } from "@/lib/registry-owner-check/permissions";
import { ownerNameKey, planOwnerReplacement } from "@/lib/registry-owner-check/compare";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ propertyId: string }> },
) {
  try {
    const { propertyId } = await context.params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const missing = findMissingRegistryOwnerReviewPerm(perms, "view");
    if (missing) throw new ApiError(403, missing, "FORBIDDEN");

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        address: true,
        dmStatus: true,
        assignedTo: true,
        createdBy: true,
        registryOwnerCheck: {
          select: { result: true, stale: true, decision: true, checkedAt: true, attachmentId: true },
        },
        propertyOwners: {
          select: {
            ownerId: true,
            isPrimary: true,
            note: true,
            owner: { select: { name: true, address: true } },
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
    }

    const registry = await loadLatestRegistryText(propertyId);
    const registryOwners = parseRegistryOwnerTable(registry.text) ?? [];
    await writeAuditLog({
      userId: session.id,
      action: "registry_pdf_preview",
      targetTable: "attachments",
      targetId: registry.attachmentId,
      detail: { propertyId },
    });

    const showAddress = isMaskFreeLevel(getOwnerFieldLevel(perms, "owner_address"));
    const linked = property.propertyOwners.map((l) => ({ ownerId: l.ownerId, name: l.owner.name }));
    const plan = planOwnerReplacement(registryOwners, linked);
    const removeSet = new Set(plan.removeOwnerIds);
    const linkedKeys = new Set(linked.map((l) => ownerNameKey(l.name)));

    return apiResponse({
      propertyId,
      address: property.address,
      dmStatus: property.dmStatus,
      check: property.registryOwnerCheck,
      attachment: {
        id: registry.attachmentId,
        // ⚠生ファイル名は返さない(氏名を含みうる)
        label: registryDisplayName(SUPPORTED_CERTIFICATE_TYPE, registry.createdAt),
      },
      systemOwners: property.propertyOwners.map((l) => ({
        ownerId: l.ownerId,
        name: l.owner.name,
        address: showAddress ? l.owner.address : null,
        isPrimary: l.isPrimary,
        willBeRemoved: removeSet.has(l.ownerId),
        // 物件ごとのメモがあると外せない(中身は返さない)
        hasNote: !!(l.note && l.note.trim()),
      })),
      registryOwners: registryOwners.map((o) => ({
        name: o.name,
        address: showAddress ? o.address : null,
        share: o.share,
        willBeAdded: !linkedKeys.has(ownerNameKey(o.name)),
      })),
      plan: {
        linkedOwnerIds: linked.map((l) => l.ownerId),
        removeOwnerIds: plan.removeOwnerIds,
        addCount: plan.add.length,
      },
      readable: registryOwners.length > 0,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
