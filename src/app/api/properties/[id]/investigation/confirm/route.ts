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
