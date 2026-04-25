import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { relinkOwnersToProperties } from "@/lib/owner-property-linker";

// ---------- POST /api/owners/relink ----------
//
// 既存の未リンク Owner (PropertyOwner を 1 件も持たない Owner) を、
// externalLinkKey / 住所正規化一致で Property に自動リンクする救済エンドポイント。
//
// owner-csv 取込ロジックと同一の判定ルールを共有するため、
// 共有名義や既存リンクは破壊しない (再実行安全)。

export async function POST(_request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 取込権限を持つユーザに限定 (一括書込みのため)
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "再リンクの権限がありません", "FORBIDDEN");
    }

    const result = await relinkOwnersToProperties();

    await writeAuditLog({
      userId: session.id,
      action: "owner_relink",
      targetTable: "property_owners",
      detail: {
        candidateOwnerCount: result.candidateOwnerCount,
        linkedCount: result.linkedCount,
        linkedByLinkKeyCount: result.linkedByLinkKeyCount,
        linkedByAddressCount: result.linkedByAddressCount,
        addressLinkAmbiguousCount: result.addressLinkAmbiguousCount,
      },
    });

    return apiResponse(result, 200);
  } catch (error) {
    return handleApiError(error);
  }
}
