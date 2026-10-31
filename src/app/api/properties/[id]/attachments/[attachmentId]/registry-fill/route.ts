/**
 * POST /api/properties/:id/attachments/:attachmentId/registry-fill
 * 「この謄本から基本情報に反映」(2026-11-01 発注者)。添付済みの謄本を読み、物件(と棟)の**空の欄だけ**を埋める。
 * 面積の自動入力より前に入れた謄本は読まれないので、押した物件だけ反映する(全件を一度に書き換えない)。
 * ⚠所有者は書かない(所有者タブの「謄本から所有者を反映」)。不動産番号も書かない(registry-basic-info.ts)。
 * ⚠謄本を storage から直接読むので、`/uploads/[...path]` と同じ閲覧の記録を残す。ファイル名・読んだ値は記録しない。
 */
import { NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { isValidStorageKey } from "@/lib/storage/key-validation";
import { fillBasicInfoFromRegistryPdfBestEffort } from "@/lib/registry-pdf/fill-areas";
import { registryFillNotice } from "@/lib/registry-basic-info";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    const { id: propertyId, attachmentId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "registry_pdf", "preview")) {
      throw new ApiError(403, "謄本を見る権限がありません", "FORBIDDEN");
    }
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, assignedTo: true, createdBy: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
    }
    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, propertyId, type: "registry", isDeleted: false },
      select: { id: true, fileUrl: true },
    });
    if (!attachment) throw new ApiError(404, "謄本が見つかりません", "REGISTRY_NOT_FOUND");

    const storage = getStorage();
    const key = storage.keyFromUrl(attachment.fileUrl);
    // ⚠この物件の保存場所のファイルだけを読む。添付の JSON の口は fileUrl をそのまま保存するので、別の物件の謄本を
    //   指す行を作れる。読むと別の物件の地番などがこの物件に入る。謄本を作る経路の key はすべて properties/<物件ID>/ の下。
    // ⚠前方一致だけだと「properties/<物件ID>/../別の物件/…」が通るので、「..」を含む key も弾く。
    const file = isValidStorageKey(key) && key.startsWith(`properties/${propertyId}/`) ? await storage.read(key) : null;
    if (!file) throw new ApiError(404, "謄本の実体が見つかりません", "REGISTRY_FILE_MISSING");

    await writeAuditLog({
      userId: session.id,
      action: "registry_pdf_preview",
      targetTable: "attachments",
      targetId: attachment.id,
      detail: { propertyId },
    });

    const outcome = await fillBasicInfoFromRegistryPdfBestEffort({
      propertyId,
      pdf: file.body,
      changedBy: session.id,
    });
    return apiResponse({
      filled: outcome.filled,
      notice: registryFillNotice(outcome, { manual: true }),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
