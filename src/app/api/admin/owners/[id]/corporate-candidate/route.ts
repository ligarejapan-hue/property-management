// GET /api/admin/owners/[id]/corporate-candidate
//
// Phase F: 単一 Owner に対する法人番号候補（Phase E と同じ分類）を返す。
// /admin/owners/[id] ページから呼び出され、Phase E の死リンクを解消する。
// DB は一切変更しない。
//
// 設計上の不変条件:
// - active Owner のみ対象（archived は 404）
// - 検出は detectCorporateNumberInOwnerLike / decideCorporateImport を再利用（PR #31/#34）
// - 国税庁 API lookup は呼ばない（Phase C の手動 UI に誘導）
// - レスポンスは display-level に従ったマスキング済（生 13桁・会社名・住所・note 生値は返さない）
// - AuditLog detail に法人番号生値・会社名・住所・候補リスト・note 本文・rawData 全文を入れない
// - 候補値を URL query で渡さない方針のため、このルートはサーバー側で再検出して返す
//
// 権限: user_management:read AND owner:read AND
//       owner_corporate_number !== hidden（Phase E 法人番号タブ API と同一ガード）

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { maskCorporateNumber } from "@/lib/display-level";
import { classifyOwnerCorporateCandidate } from "@/lib/owner-corporate-candidates";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    // Phase E API と同じガード:
    //   hidden → 403、それ以外は通過。
    //   ownerNumber 候補値は full のみ生値、それ以外マスク。
    if (displayConfig.corporateNumber === "hidden") {
      throw new ApiError(403, "法人番号の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        address: true,
        note: true,
        corporateNumber: true,
        version: true,
        isArchived: true,
        _count: { select: { propertyOwners: true } },
      },
    });

    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // Phase E と同じヘルパで分類。raw-visible でないフィールドは検出対象外。
    const candidate = classifyOwnerCorporateCandidate(
      {
        id: owner.id,
        name: owner.name,
        address: owner.address,
        note: owner.note,
        corporateNumber: owner.corporateNumber,
        version: owner.version,
      },
      {
        name: displayConfig.name,
        address: displayConfig.address,
        corporateNumber: displayConfig.corporateNumber,
        note: displayConfig.note,
      },
    );

    // Owner 概要（候補有無に関わらず返す）。display-level マスキング適用。
    // 法人番号は full のみ生値、それ以外マスク、hidden 時は 403 で到達しないため null 化はない。
    const cnLevel = displayConfig.corporateNumber;
    const existingCorporateNumberMasked =
      owner.corporateNumber == null
        ? null
        : cnLevel === "full"
          ? owner.corporateNumber
          : maskCorporateNumber(owner.corporateNumber);

    const overview = {
      ownerId: owner.id,
      ownerNameMasked: maskValue(owner.name, displayConfig.name),
      ownerAddressMasked: maskValue(owner.address, displayConfig.address),
      existingCorporateNumberMasked,
      version: owner.version,
      propertyOwnerCount: owner._count.propertyOwners,
    };

    // AuditLog（PII を入れない / 候補値・会社名・住所・note 本文を入れない）
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_corporate_candidate_view",
      targetTable: "owners",
      targetId: id,
      detail: {
        hasCandidate: candidate !== null,
        type: candidate?.type ?? null,
        detectedInCount: candidate?.detectedIn.length ?? 0,
      },
    });

    return apiResponse({
      owner: overview,
      candidate, // 候補 row（Phase E と同じ DTO 形式）または null
    });
  } catch (error) {
    return handleApiError(error);
  }
}
