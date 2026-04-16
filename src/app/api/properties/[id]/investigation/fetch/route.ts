import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { runAndUpsertInvestigation } from "@/lib/investigation/fetch-investigation";

// ---------- POST /api/properties/[id]/investigation/fetch ----------
// Trigger investigation providers, upsert PropertyInvestigation with status=needs_review

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        gpsLat: true,
        gpsLng: true,
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    let targetYear: number | undefined;
    try {
      const body = await request.json();
      if (body?.targetYear) targetYear = Number(body.targetYear);
    } catch {
      // Empty body is fine
    }

    const investigation = await runAndUpsertInvestigation(id, session.id, {
      address: property.address,
      lotNumber: property.lotNumber,
      gpsLat: property.gpsLat ? Number(property.gpsLat) : null,
      gpsLng: property.gpsLng ? Number(property.gpsLng) : null,
      targetYear,
    });

    await writeAuditLog({
      userId: session.id,
      action: "investigation_fetch",
      targetTable: "property_investigations",
      targetId: investigation.id,
      detail: { propertyId: id },
    });

    return apiResponse({ investigation });
  } catch (error) {
    return handleApiError(error);
  }
}
