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
import { getDesign } from "@/lib/sales-sheet/design-service";
import { parseSalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { authorizeAndInlineDocumentImages } from "@/lib/sales-sheet/authorize-document-images";
import { isChromiumAvailable } from "@/lib/sales-sheet/output";
import { renderDocumentToPdf, renderDocumentToImage } from "@/lib/sales-sheet/render-to-output";

// POST /api/properties/[id]/sales-sheets/[sheetId]/export?format=pdf|png
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; sheetId: string }> },
) {
  try {
    const { id, sheetId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, createdBy: true, assignedTo: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
    }

    const design = await getDesign(id, sheetId);
    if (!design) throw new ApiError(404, "販売図面が見つかりません", "NOT_FOUND");

    // 破損 document は 422（Zod バリデーションエラーが handleApiError で変換される）
    const doc = parseSalesSheetDocument(design.document);

    if (!isChromiumAvailable()) {
      throw new ApiError(503, "PDF生成が利用できません（サーバー未設定）", "PDF_UNAVAILABLE");
    }

    const authorizedDoc = await authorizeAndInlineDocumentImages(doc, { session, permissions });

    const url = new URL(request.url);
    const format = url.searchParams.get("format") ?? "pdf";

    if (format === "png") {
      const buffer = await renderDocumentToImage(authorizedDoc, "png");
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": 'inline; filename="sales-sheet.png"',
          "Cache-Control": "no-store",
        },
      });
    }

    const buffer = await renderDocumentToPdf(authorizedDoc);
    return new NextResponse(new Uint8Array(buffer), {
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
