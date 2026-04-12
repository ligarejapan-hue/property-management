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

const createBuildingSchema = z.object({
  name: z.string().min(1, "マンション名は必須です"),
  address: z.string().min(1, "住所は必須です"),
  lotNumber: z.string().optional(),
  realEstateNumber: z.string().optional(),
  totalFloors: z.number().int().positive().optional(),
  totalUnits: z.number().int().positive().optional(),
  builtYear: z.number().int().optional(),
  structureType: z.string().optional(),
  managementCompany: z.string().optional(),
  note: z.string().optional(),
  gpsLat: z.number().optional(),
  gpsLng: z.number().optional(),
});

// ---------- GET /api/buildings ----------

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("keyword")?.trim() ?? "";

    const where = q.length >= 2
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { address: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {};

    const buildings = await prisma.building.findMany({
      where,
      include: {
        _count: { select: { properties: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    return apiResponse({ data: buildings });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/buildings ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = createBuildingSchema.parse(body);

    const building = await prisma.building.create({
      data: {
        name: data.name,
        address: data.address,
        lotNumber: data.lotNumber,
        realEstateNumber: data.realEstateNumber,
        totalFloors: data.totalFloors,
        totalUnits: data.totalUnits,
        builtYear: data.builtYear,
        structureType: data.structureType,
        managementCompany: data.managementCompany,
        note: data.note,
        gpsLat: data.gpsLat,
        gpsLng: data.gpsLng,
        createdBy: session.id,
      },
      include: {
        creator: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "buildings",
      targetId: building.id,
      detail: { name: building.name, address: building.address },
    });

    return apiResponse(building, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
