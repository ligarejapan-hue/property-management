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
import {
  buildSaleLandDocument,
  buildSaleMansionDocument,
  buildSaleHouseDocument,
  buildSaleBuildingDocument,
  toCanonicalUploadsSrc,
} from "@/lib/sales-sheet/build-document";
import type { SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { salesSheetTemplateKindFor } from "@/lib/sales-sheet/template-kind";
import { isImageKeyAuthorizedForProperty } from "@/lib/sales-sheet/authorize-document-images";
import { getStorage } from "@/lib/storage";
import { writeAuditLog } from "@/lib/audit";

// 作成ダイアログが収集する任意の上書き項目（システムに無い値）。種別ごとに異なる。
const landOverridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  landCategory: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
});
const mansionOverridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  builtYearMonth: z.string().max(100).optional(),
  structure: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
});
const houseOverridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  buildingArea: z.string().max(200).optional(),
  builtYearMonth: z.string().max(100).optional(),
  structure: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
});
const buildingOverridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  totalFloorArea: z.string().max(200).optional(),
  totalUnits: z.string().max(50).optional(),
  builtYearMonth: z.string().max(100).optional(),
  structure: z.string().max(200).optional(),
  grossYield: z.string().max(100).optional(),
  expectedIncome: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
});

// POST /api/properties/[id]/sales-sheets/new
// property データから種別に応じた初期 document を生成して design を作成し { id } を返す。
// 対応する種別（土地/区分マンション/戸建/一棟マンション・アパート）以外は 422。
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
        // 区分マンション用
        roomNo: true,
        exclusiveArea: true,
        balconyArea: true,
        layoutType: true,
        floorNo: true,
        orientation: true,
        managementFee: true,
        repairReserveFee: true,
        building: {
          select: { name: true, totalFloors: true, builtYear: true, structureType: true },
        },
      },
    });

    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
    }
    const kind = salesSheetTemplateKindFor(property.propertyType);
    if (!kind) {
      throw new ApiError(422, "この物件種別では販売図面を作成できません", "INVALID_PROPERTY_TYPE");
    }

    // 作成ダイアログの上書き項目（空ボディ → {}・不正 JSON → 400）。
    const body = await parseJsonBody(request);

    // 写真を最大 N 枚 seed。保存前に1枚ずつ認可（caller が読める＋この物件に属する）。
    // 未認可 / 解決不能 / 別物件は落とす（サーバ生成は 422 ではなく drop 方針）＝未認可 key を
    // document に入れない＝GET で未認可 raw key を返さないことを保証する。順序は isPrimary→sortOrder。
    const seedPhotos = async (max: number): Promise<{ fileUrl: string }[]> => {
      const rows = await prisma.propertyPhoto.findMany({
        where: { propertyId: id },
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
        take: max,
        select: { fileUrl: true },
      });
      const out: { fileUrl: string }[] = [];
      for (const r of rows) {
        const src = toCanonicalUploadsSrc(r.fileUrl);
        if (!src) continue;
        const key = getStorage().keyFromUrl(src);
        if (!key) continue;
        if (await isImageKeyAuthorizedForProperty(key, { session, permissions, propertyId: id })) {
          out.push({ fileUrl: src });
        }
      }
      return out;
    };
    const photos = await seedPhotos(kind === "land" ? 1 : 3);

    let document: SalesSheetDocument;
    let templateId: string;

    if (kind === "land") {
      const o = landOverridesSchema.parse(body);
      document = buildSaleLandDocument({
        property: {
          address: property.address,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          // 現況の日本語化は各ビルダー内部で行う（全テンプレで統一）。
          occupancyStatus: property.occupancyStatus,
        },
        photo: photos[0] ?? null,
        overrides: o,
      });
      templateId = "sale-land";
    } else if (kind === "mansion") {
      const o = mansionOverridesSchema.parse(body);
      document = buildSaleMansionDocument({
        property: {
          address: property.address,
          roomNo: property.roomNo,
          exclusiveArea: property.exclusiveArea?.toString() ?? null,
          balconyArea: property.balconyArea?.toString() ?? null,
          layoutType: property.layoutType,
          floorNo: property.floorNo,
          orientation: property.orientation,
          managementFee: property.managementFee,
          repairReserveFee: property.repairReserveFee,
          zoningDistrict: property.zoningDistrict,
          occupancyStatus: property.occupancyStatus,
        },
        building: property.building
          ? {
              name: property.building.name,
              totalFloors: property.building.totalFloors,
              builtYear: property.building.builtYear,
              structureType: property.building.structureType,
            }
          : null,
        photos,
        overrides: o,
      });
      templateId = "sale-mansion";
    } else if (kind === "house") {
      const o = houseOverridesSchema.parse(body);
      document = buildSaleHouseDocument({
        property: {
          address: property.address,
          layoutType: property.layoutType,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          occupancyStatus: property.occupancyStatus,
        },
        photos,
        overrides: o,
      });
      templateId = "sale-house";
    } else {
      const o = buildingOverridesSchema.parse(body);
      document = buildSaleBuildingDocument({
        property: {
          address: property.address,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          occupancyStatus: property.occupancyStatus,
        },
        kind: property.propertyType === "apartment_block" ? "apartment" : "mansion",
        photos,
        overrides: o,
      });
      templateId = "sale-building";
    }

    const design = await createDesign({ propertyId: id, document, userId: session.id, templateId });

    // 監査ログ（非PIIメタのみ: document 本文・画像 key・overrides・住所等は記録しない）。
    await writeAuditLog({
      userId: session.id,
      action: "sales_sheet_design_create",
      targetTable: "sales_sheet_designs",
      targetId: design.id,
      detail: { propertyId: id },
    });

    return NextResponse.json({ id: design.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
