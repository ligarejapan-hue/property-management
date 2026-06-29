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
import { buildSaleLandDocument, toCanonicalUploadsSrc, type SaleLandInput } from "@/lib/sales-sheet/build-document";
import { isImageKeyAuthorizedForProperty } from "@/lib/sales-sheet/authorize-document-images";
import { getStorage } from "@/lib/storage";
import { localizeOccupancy } from "@/lib/property-types";
import { writeAuditLog } from "@/lib/audit";

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

    // 代表写真（buildSaleLandDocument は owner を使わないため owner 取得は行わない）。
    const photoRow = await prisma.propertyPhoto.findFirst({
      where: { propertyId: id },
      orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
      select: { fileUrl: true },
    });
    // Normalize to the canonical /uploads/{key} form so the saved image src
    // passes isSafeImageSrc on every storage backend (server backend may
    // persist /{bucket}/{key} or absolute URLs). Export re-resolves the key via
    // keyFromUrl. Unresolvable key → drop the photo.
    let photoSrc = toCanonicalUploadsSrc(photoRow?.fileUrl);
    // 代表写真も保存前に認可（caller が読める＋この物件に属する）。NG / 解決不能 / 別物件は
    // 写真なしで初期図面を作成（サーバ生成は 422 ではなく drop 方針）。未認可 key を document に
    // 入れない＝GET で未認可 raw key を返さないことを保証する。
    if (photoSrc) {
      const photoKey = getStorage().keyFromUrl(photoSrc);
      if (
        !photoKey ||
        !(await isImageKeyAuthorizedForProperty(photoKey, { session, permissions, propertyId: id }))
      ) {
        photoSrc = null;
      }
    }

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
      photo: photoSrc ? { fileUrl: photoSrc } : null,
      overrides,
    };

    const document = buildSaleLandDocument(input);
    const design = await createDesign({ propertyId: id, document, userId: session.id });

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
