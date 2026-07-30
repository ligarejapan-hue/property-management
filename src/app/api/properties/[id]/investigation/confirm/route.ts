import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { assertPropertyRecordAccess } from "@/lib/property-record-guard";
import { confirmInvestigationRecord } from "@/lib/investigation/fetch-investigation";

// ---------- POST /api/properties/[id]/investigation/confirm ----------
// Set investigation status=confirmed, copy fields to Property

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    await assertPropertyRecordAccess(id, session, "write");

    const investigation = await confirmInvestigationRecord(id, session.id);

    await writeAuditLog({
      userId: session.id,
      action: "investigation_confirm",
      targetTable: "property_investigations",
      targetId: investigation.id,
      detail: { propertyId: id, confirmedAt: investigation.confirmedAt },
    });

    return apiResponse({
      investigation,
      message: "調査情報を確認済みにしました",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
