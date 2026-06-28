import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { createDesign } from "@/lib/sales-sheet/design-service";
import { buildSaleLandDocument, type SaleLandInput } from "@/lib/sales-sheet/build-document";

// POST /api/properties/[id]/sales-sheets/new
// 売土地専用: property データから初期 document を生成して design を作成し { id } を返す。
// 土地物件以外は 422。
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    // Access check + scalar fields
    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        createdBy: true,
        assignedTo: true,
        propertyType: true,
        address: true,
        zoningDistrict: true,
        buildingCoverageRatio: true,
        floorAreaRatio: true,
        roadType: true,
        roadWidth: true,
        occupancyStatus: true,
      },
    });

    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
    }
    if (property.propertyType !== "land") {
      throw new ApiError(422, "売土地のみ販売図面を作成できます", "INVALID_PROPERTY_TYPE");
    }

    // Owner + photo (separate queries to avoid Prisma select/include mixing issues)
    const ownerRel = await prisma.propertyOwner.findFirst({
      where: { propertyId: id },
      select: { owner: { select: { name: true } } },
    });
    const photo = await prisma.propertyPhoto.findFirst({
      where: { propertyId: id },
      orderBy: { sortOrder: "asc" },
      select: { fileUrl: true },
    });

    const input: SaleLandInput = {
      property: {
        address: property.address,
        zoningDistrict: property.zoningDistrict,
        buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
        floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
        roadType: property.roadType,
        roadWidth: property.roadWidth?.toString() ?? null,
        occupancyStatus: property.occupancyStatus,
      },
      owner: ownerRel?.owner ?? null,
      photo: photo ?? null,
    };

    const document = buildSaleLandDocument(input);
    const design = await createDesign({ propertyId: id, document, userId: session.id });

    return NextResponse.json({ id: design.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
