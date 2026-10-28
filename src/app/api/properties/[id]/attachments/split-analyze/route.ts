/**
 * POST /api/properties/:id/attachments/split-analyze — まとめてある PDF の分け方の案(保存はしない)。
 *
 * 発注者の依頼(2026-10-28)「まとめてあるPDFが来ることもある」→ 物件の画面の1つの枠に入れた PDF を
 * まずここで見て、2つ以上の書類が入っていれば分け方の確認を出す(1つならいつもどおり保存)。
 * ⚠返すのはページ数・ページごとの種類の code・分け方だけ。読んだ文字は返さない・残さない
 *   (謄本のページには氏名が入る)。
 * ⚠この口は proxy を通らない(大きいPDFのため・src/proxy.ts)=本文を読む前に認証と大きさを見る。
 */
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { assertImportMultipartBodySize } from "@/lib/import-body-size";
import { MAX_PDF_UPLOAD_BYTES, pdfTooLargeToAcceptMessage } from "@/lib/pdf-compress/policy";
import { reserveSplitSlot } from "@/lib/pdf-split/slot";
import { isPdfBuffer } from "@/lib/pdf-extract";
import { analyzeBundlePdf } from "@/lib/pdf-split/analyze";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let releaseSlot = () => {};
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    assertImportMultipartBodySize(request, MAX_PDF_UPLOAD_BYTES);
    // 小さい PDF でも読み取りの列に並ぶので、大きさによらず席を取る(取れなければすぐ 503)。
    releaseSlot = reserveSplitSlot();
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
    }
    if (file.size <= 0) throw new ApiError(422, "空ファイルはアップロードできません", "VALIDATION_ERROR");
    if (file.size > MAX_PDF_UPLOAD_BYTES) throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isPdfBuffer(buffer)) throw new ApiError(422, "PDFファイルではありません", "VALIDATION_ERROR");

    const analysis = await analyzeBundlePdf(buffer);
    // 読めない PDF は「分けない」と答える(画面はいつもどおり1つで保存する)。
    if (analysis === null) {
      return apiResponse({ pageCount: null, pageKinds: [], segments: [], ocr: "skipped", tooManyPages: false });
    }
    return apiResponse(analysis);
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
