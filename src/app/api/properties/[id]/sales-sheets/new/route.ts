import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  parseJsonBody,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { createDesign } from "@/lib/sales-sheet/design-service";
import { buildSaleLandDocument, type SaleLandInput } from "@/lib/sales-sheet/build-document";
import { localizeOccupancy } from "@/lib/property-types";

// 作成ダイアログが収集する任意の上書き項目（売土地でシステムに無い値）。
const overridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  landCategory: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
});

// POST /api/properties/[id]/sales-sheets/new
// 売土地専用: property データから初期 document を生成して design を作成し { id } を返す。
// 土地物件以外は 422。
export async function POST(
  request: Request,
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

    // 作成ダイアログの上書き項目（空ボディ → {}・不正 JSON → 400）。
    const overrides = overridesSchema.parse(await parseJsonBody(request));

    // Owner + photo (separate queries to avoid Prisma select/include mixing issues)
    const ownerRel = await prisma.propertyOwner.findFirst({
      where: { propertyId: id },
      select: { owner: { select: { name: true } } },
    });
    const photo = await prisma.propertyPhoto.findFirst({
      where: { propertyId: id },
      orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
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
        occupancyStatus: localizeOccupancy(property.occupancyStatus),
      },
      owner: ownerRel?.owner ?? null,
      photo: photo ?? null,
      overrides,
    };

    const document = buildSaleLandDocument(input);
    const design = await createDesign({ propertyId: id, document, userId: session.id });

    return NextResponse.json({ id: design.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
