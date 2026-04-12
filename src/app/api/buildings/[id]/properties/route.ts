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

const createUnitSchema = z.object({
  address: z.string().min(1, "住所は必須です"),
  roomNo: z.string().optional(),
  floorNo: z.number().int().optional(),
  exclusiveArea: z.number().optional(),
  balconyArea: z.number().optional(),
  layoutType: z.string().optional(),
  orientation: z.string().optional(),
  managementFee: z.number().int().optional(),
  repairReserveFee: z.number().int().optional(),
  occupancyStatus: z.enum(["vacant", "occupied", "unknown"]).optional(),
  ownershipShareNote: z.string().optional(),
  realEstateNumber: z.string().optional(),
  note: z.string().optional(),
});

// ---------- GET /api/buildings/:id/properties ----------

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
      select: { id: true },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    const properties = await prisma.property.findMany({
      where: { buildingId: id },
      include: {
        creator: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        propertyOwners: {
          include: { owner: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: [{ floorNo: "asc" }, { roomNo: "asc" }],
    });

    return apiResponse({ data: properties });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/buildings/:id/properties ----------

export async function POST(
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

    const building = await prisma.building.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    const body = await request.json();
    const data = createUnitSchema.parse(body);

    const property = await prisma.property.create({
      data: {
        propertyType: "unit",
        address: data.address,
        buildingId: id,
        roomNo: data.roomNo,
        floorNo: data.floorNo,
        exclusiveArea: data.exclusiveArea,
        balconyArea: data.balconyArea,
        layoutType: data.layoutType,
        orientation: data.orientation,
        managementFee: data.managementFee,
        repairReserveFee: data.repairReserveFee,
        occupancyStatus: data.occupancyStatus,
        ownershipShareNote: data.ownershipShareNote,
        realEstateNumber: data.realEstateNumber,
        note: data.note,
        registryStatus: "unconfirmed",
        dmStatus: "hold",
        caseStatus: "new_case",
        createdBy: session.id,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "properties",
      targetId: property.id,
      detail: {
        buildingId: id,
        buildingName: building.name,
        roomNo: data.roomNo,
        propertyType: "unit",
      },
    });

    return apiResponse(property, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
