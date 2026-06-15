// GET  /api/admin/owners/[id]/registry-address-cleanup  … preview(dry-run・DB 無変更)
// POST /api/admin/owners/[id]/registry-address-cleanup  … apply(明示確定・address のみ)
//
// DQ-03: 所有者住所に混入した登記由来文字列（受付番号/和暦日付/登記原因/持分/証明書定型文）の
// 監査→明示 apply。会社法人等番号/法人番号 cleanup（corporate-*）とは独立した自前 route。
//
// 設計上の不変条件（corporate-cleanup route 踏襲）:
// - 自動上書きしない（POST で apply.address を明示）。サーバ側で proposal を再計算し client 値を信用しない。
// - owner:write + owner_address field-level write（hasExplicitWritePerm）を厳格に要求。
// - display-level raw-visible（full/read/edit）の address のみ検出・除去対象にする（bypass 防止）。
// - 監査専用類型（地番ラベル/不動産番号/床面積 等）は apply 不可（action!=="cleanup" → 409）。
// - version 楽観ロック。AuditLog detail に住所本文・検出文字列の生値を一切含めない（件数・type のみ）。
import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm, maskValue } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import { decideRegistryAddressCleanup } from "@/lib/registry-address-cleanup";

type Level = "hidden" | "masked" | "partial" | "full" | "read" | "edit";

function isRawVisible(level: Level): boolean {
  return level === "full" || level === "read" || level === "edit";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const cfg = await getOwnerDisplayConfig(session.id, perms);
    const addrLevel = cfg.address as Level;
    if (!isRawVisible(addrLevel)) {
      // 住所の生値が見えない権限では検出・補正をさせない（bypass 防止）。
      throw new ApiError(403, "住所の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, address: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const proposal = decideRegistryAddressCleanup({ address: owner.address });

    await writeAuditLog({
      userId: session.id,
      action: "owner_registry_address_cleanup_preview",
      targetTable: "owners",
      targetId: id,
      detail: {
        action: proposal.action,
        detectedTypes: proposal.detectedTypes,
        removableTypeCount: proposal.removableTypes.length,
        auditOnlyTypeCount: proposal.auditOnlyTypes.length,
        manualReviewRequired: proposal.manualReviewRequired,
      },
    });

    return apiResponse({
      cleanup: {
        action: proposal.action,
        manualReason: proposal.manualReason,
        detectedTypes: proposal.detectedTypes,
        removableTypes: proposal.removableTypes,
        auditOnlyTypes: proposal.auditOnlyTypes,
        manualReviewRequired: proposal.manualReviewRequired,
        changed: proposal.changed,
        version: owner.version,
        before: { addressMasked: maskValue(owner.address, addrLevel) },
        after: { addressMasked: maskValue(proposal.cleanedAddress, addrLevel) },
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const applySchema = z.object({
  version: z.number().int(),
  apply: z.object({ address: z.boolean() }),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let auditUserId: string | null = null;
  let auditOwnerId: string | null = null;
  let auditResult = "validation_error";
  let auditHttpStatus: number | null = null;
  let auditDetectedTypes: string[] = [];

  try {
    const { id } = await params;
    auditOwnerId = id;
    const session = await getApiSession();
    auditUserId = session.id;
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      auditResult = "forbidden";
      throw new ApiError(403, "所有者を更新する権限がありません", "FORBIDDEN");
    }
    if (!hasExplicitWritePerm(perms, "owner_address")) {
      auditResult = "forbidden";
      throw new ApiError(403, "住所を更新する権限がありません", "FORBIDDEN");
    }

    const raw = (await request.json().catch(() => ({}))) as unknown;
    const parsed = applySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(400, "リクエスト形式が不正です", "VALIDATION_ERROR");
    }
    const body = parsed.data;
    if (!body.apply.address) {
      throw new ApiError(400, "反映対象が指定されていません", "VALIDATION_ERROR");
    }

    const cfg = await getOwnerDisplayConfig(session.id, perms);
    const addrLevel = cfg.address as Level;
    if (!isRawVisible(addrLevel)) {
      auditResult = "forbidden";
      throw new ApiError(403, "住所の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, address: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      auditResult = "not_found";
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const proposal = decideRegistryAddressCleanup({ address: owner.address });
    auditDetectedTypes = proposal.detectedTypes;

    // 監査専用のみ / 検出なし は自動 apply 不可（人手確認に誘導）。
    if (proposal.action !== "cleanup") {
      auditResult = "not_available";
      throw new ApiError(
        409,
        "自動で適用できる住所の登記文字列除去がありません（監査専用の検出は手動で確認してください）",
        "CLEANUP_NOT_AVAILABLE",
      );
    }

    const result = await prisma.owner.updateMany({
      where: { id, version: body.version },
      data: { address: proposal.cleanedAddress, version: { increment: 1 } },
    });
    if (result.count === 0) {
      auditResult = "version_conflict";
      throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
    }

    await recordChanges({
      targetTable: "owners",
      targetId: id,
      changedBy: session.id,
      oldValues: owner as unknown as Record<string, unknown>,
      newValues: { address: proposal.cleanedAddress },
      trackedFields: OWNER_TRACKED_FIELDS,
    });

    auditResult = "applied";
    auditHttpStatus = 200;
    await writeAuditLog({
      userId: session.id,
      action: "owner_registry_address_cleanup_apply",
      targetTable: "owners",
      targetId: id,
      detail: {
        result: auditResult,
        httpStatus: auditHttpStatus,
        detectedTypes: auditDetectedTypes,
        removableTypeCount: proposal.removableTypes.length,
        manualReviewRequired: proposal.manualReviewRequired,
      },
    });

    return apiResponse({ ok: true, owner: { id, version: body.version + 1 } });
  } catch (error) {
    if (auditUserId && auditOwnerId && error instanceof Error && "status" in error) {
      auditHttpStatus = (error as ApiError).status;
      try {
        await writeAuditLog({
          userId: auditUserId,
          action: "owner_registry_address_cleanup_apply",
          targetTable: "owners",
          targetId: auditOwnerId,
          detail: {
            result: auditResult,
            httpStatus: auditHttpStatus,
            detectedTypes: auditDetectedTypes,
          },
        });
      } catch {
        // audit 失敗は本処理を壊さない
      }
    }
    return handleApiError(error);
  }
}
