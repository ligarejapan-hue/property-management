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
import { recordChanges } from "@/lib/change-log";

const PROPERTY_INVESTIGATION_FIELDS = [
  "zoningDistrict",
  "buildingCoverageRatio",
  "floorAreaRatio",
  "heightDistrict",
  "firePreventionZone",
  "scenicRestriction",
  "roadType",
  "roadWidth",
  "frontageWidth",
  "frontageDirection",
  "setbackRequired",
  "rosenkaValue",
  "rosenkaYear",
  "rebuildPermission",
  "architectureNote",
];

// ---------- POST /api/properties/[id]/investigation/confirm ----------
// Confirm investigation data and write it to the property record

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

    const body = await request.json();
    const data = body as Record<string, unknown>;

    // Verify property exists and get current values for change tracking
    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        version: true,
        zoningDistrict: true,
        buildingCoverageRatio: true,
        floorAreaRatio: true,
        heightDistrict: true,
        firePreventionZone: true,
        scenicRestriction: true,
        roadType: true,
        roadWidth: true,
        frontageWidth: true,
        frontageDirection: true,
        setbackRequired: true,
        rosenkaValue: true,
        rosenkaYear: true,
        rebuildPermission: true,
        architectureNote: true,
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // Build update data from confirmed investigation fields
    const updateData: Record<string, unknown> = {};
    for (const field of PROPERTY_INVESTIGATION_FIELDS) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      throw new ApiError(400, "確認するデータがありません", "NO_DATA");
    }

    // Build old values for change tracking (convert Decimals to numbers)
    const oldValues: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(property)) {
      if (key === "id" || key === "version") continue;
      oldValues[key] =
        val !== null && typeof val === "object" && "toNumber" in val
          ? (val as { toNumber(): number }).toNumber()
          : val;
    }

    // Update property with investigation data + set confirmedAt
    const confirmedAt = new Date();
    await prisma.property.update({
      where: { id },
      data: {
        ...updateData,
        investigationConfirmedAt: confirmedAt,
        investigationSource:
          (data._source as string) || "手動確認",
        version: { increment: 1 },
      },
    });

    // Record field-level changes
    await recordChanges({
      targetTable: "properties",
      targetId: id,
      changedBy: session.id,
      oldValues,
      newValues: updateData,
      trackedFields: PROPERTY_INVESTIGATION_FIELDS,
      source: "api",
    });

    // Mark latest investigation log as manually edited if data was changed
    const latestLog = await prisma.propertyInvestigationLog.findFirst({
      where: { propertyId: id },
      orderBy: { fetchedAt: "desc" },
    });

    if (latestLog) {
      await prisma.propertyInvestigationLog.update({
        where: { id: latestLog.id },
        data: { manuallyEdited: true },
      });
    }

    await writeAuditLog({
      userId: session.id,
      action: "investigation_confirm",
      targetTable: "properties",
      targetId: id,
      detail: { confirmedFields: Object.keys(updateData) },
    });

    return apiResponse({
      message: "調査情報を確認しました",
      confirmedAt: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
