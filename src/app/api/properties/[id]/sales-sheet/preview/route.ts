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
import { buildInitialSalesSheetDocument } from "@/lib/sales-sheet/build-document";
import { renderDocumentToPdf } from "@/lib/sales-sheet/render-to-output";
import { isChromiumAvailable } from "@/lib/sales-sheet/output";

const overridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  landCategory: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
});

function s(v: unknown): string | null {
  return v == null ? null : String(v);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      include: { building: true, photos: { orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }], take: 1 } },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
    }

    const overrides = overridesSchema.parse(await parseJsonBody(request));

    if (!isChromiumAvailable()) {
      throw new ApiError(503, "PDF生成が利用できません（サーバー未設定）", "PDF_UNAVAILABLE");
    }

    const photo = property.photos[0] ? { fileUrl: property.photos[0].fileUrl } : null;
    const doc = await buildInitialSalesSheetDocument({
      property: {
        address: property.address,
        zoningDistrict: s(property.zoningDistrict),
        buildingCoverageRatio: s(property.buildingCoverageRatio),
        floorAreaRatio: s(property.floorAreaRatio),
        roadType: s(property.roadType),
        roadWidth: s(property.roadWidth),
        occupancyStatus: s(property.occupancyStatus),
        note: s(property.note),
      },
      photo,
      overrides,
    });

    const pdfBuffer = await renderDocumentToPdf(doc);
    // Cast to Uint8Array: NextResponse BodyInit accepts Uint8Array but not Node Buffer directly in TS
    const pdf = new Uint8Array(pdfBuffer);
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="sales-sheet.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
