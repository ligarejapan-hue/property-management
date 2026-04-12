import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { recordChanges, BUILDING_TRACKED_FIELDS } from "@/lib/change-log";

const updateBuildingSchema = z.object({
  name: z.string().min(1, "棟名は必須です").optional(),
  address: z.string().min(1, "住所は必須です").optional(),
  lotNumber: z.string().nullable().optional(),
  realEstateNumber: z.string().nullable().optional(),
  totalFloors: z.number().int().positive().nullable().optional(),
  totalUnits: z.number().int().positive().nullable().optional(),
  builtYear: z.number().int().nullable().optional(),
  structureType: z.string().nullable().optional(),
  managementCompany: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  gpsLat: z.number().nullable().optional(),
  gpsLng: z.number().nullable().optional(),
  version: z.number().int().optional(),
});

// ---------- GET /api/buildings/:id ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const building = await prisma.building.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true } },
        _count: { select: { properties: true } },
      },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    return apiResponse(building);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/buildings/:id ----------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.building.findUnique({
      where: { id },
      select: {
        id: true,
        version: true,
        name: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        totalFloors: true,
        totalUnits: true,
        builtYear: true,
        structureType: true,
        managementCompany: true,
        gpsLat: true,
        gpsLng: true,
        note: true,
      },
    });

    if (!existing) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = updateBuildingSchema.parse(body);

    // Optimistic locking
    if (data.version !== undefined && data.version !== existing.version) {
      throw new ApiError(
        409,
        "データが他のユーザーにより更新されています。画面をリロードしてください。",
        "CONFLICT",
      );
    }

    const { version: _v, ...updateFields } = data;
    const updateData: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(updateFields)) {
      if (val !== undefined) updateData[key] = val;
    }
    updateData.version = { increment: 1 };

    const building = await prisma.building.update({
      where: { id },
      data: updateData,
      include: {
        creator: { select: { id: true, name: true } },
        _count: { select: { properties: true } },
      },
    });

    // Record field-level changes
    const oldValues: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(existing)) {
      if (key === "id" || key === "version") continue;
      oldValues[key] =
        val !== null && typeof val === "object" && "toNumber" in val
          ? (val as { toNumber(): number }).toNumber()
          : val;
    }
    await recordChanges({
      targetTable: "buildings",
      targetId: id,
      changedBy: session.id,
      oldValues,
      newValues: updateFields,
      trackedFields: BUILDING_TRACKED_FIELDS,
      source: "manual",
    });

    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "buildings",
      targetId: id,
      detail: { updatedFields: Object.keys(updateFields) },
    });

    return apiResponse(building);
  } catch (error) {
    return handleApiError(error);
  }
}
