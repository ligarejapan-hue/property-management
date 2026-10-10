import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { assertImportMultipartBodySize } from "@/lib/import-body-size";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  MAX_PDF_UPLOAD_BYTES,
  isPdfByMimeOrName,
  pdfTooLargeToAcceptMessage,
} from "@/lib/pdf-compress/policy";
import { fitPdfToLimit, reserveLargePdfSlot } from "@/lib/pdf-compress/fit";
import { runExclusive } from "@/lib/pdf-compress/run";
import { assertReportInboxAccess, propertyScopeWhere, reportInboxStorageKey } from "@/lib/report-inbox/access";
import { extractReportClues } from "@/lib/report-inbox/extract";
import { findReportCandidates, type CandidateDb } from "@/lib/report-inbox/candidates";
import { canAccessPropertyRecord } from "@/lib/property-access";

// ---------- 査定報告書の受け取り箱(2026-10-10) ----------
// GET  /api/report-inbox … 未処理の報告書と、それぞれの添付先の候補
// POST /api/report-inbox … 報告書PDFを1つ受け取る(multipart: file)
//
// ⚠この口は大きいPDF(最大50MB)を受けるため proxy を通さない(src/proxy.ts)。
//   本文を読む前に、認証 → 権限 → Content-Length の確認 → 席の確保 の順に行う。

/** 一覧に出す件数の上限(未処理が溜まりすぎたときに画面が重くならないように)。 */
const LIST_LIMIT = 100;

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(perms);

    const items = await prisma.reportInboxItem.findMany({
      // 削除が途中で止まったもの(discarding)も出す=もう一度「削除」を押せるように。
      where: { status: { in: ["pending", "discarding"] } },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    });
    const uploaderIds = [...new Set(items.map((i) => i.uploadedBy))];
    const users = uploaderIds.length
      ? await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    const data = [];
    for (const item of items) {
      // ⚠呼び出した人が開ける物件だけを候補にする(担当外の住所・建物名を見せない・@codex PR#500)。
      const candidates = await findReportCandidates(prisma as unknown as CandidateDb, item, {
        scopeWhere: propertyScopeWhere(session),
        canAccess: (p) =>
          canAccessPropertyRecord(session, { createdBy: p.createdBy ?? "", assignedTo: p.assignedTo ?? null }),
      });
      data.push({
        id: item.id,
        fileName: item.fileName,
        fileSize: item.fileSize,
        originalSize: item.originalSize,
        source: item.source,
        status: item.status,
        buildingName: item.buildingName,
        roomNo: item.roomNo,
        address: item.address,
        createdAt: item.createdAt,
        uploaderName: nameOf.get(item.uploadedBy) ?? null,
        candidates,
      });
    }
    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  let releaseSlot = () => {};
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(perms);

    assertImportMultipartBodySize(request, MAX_PDF_UPLOAD_BYTES);
    // 8MB を超える送信は、本文を読む前に圧縮・読み取りの席を取る(埋まっていれば 503)。
    releaseSlot = reserveLargePdfSlot(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob) || file.size <= 0) {
      throw new ApiError(422, "PDFファイルを選んでください", "VALIDATION_ERROR");
    }
    const fileName = ((file as File).name || "report.pdf").slice(0, 200);
    if (!isPdfByMimeOrName(file.type, fileName)) {
      throw new ApiError(422, "PDFファイルだけを受け付けます", "VALIDATION_ERROR");
    }
    if (file.size > MAX_PDF_UPLOAD_BYTES) {
      throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");
    }
    const original = Buffer.from(await file.arrayBuffer());
    if (!isPdfBuffer(original)) {
      throw new ApiError(422, "PDFファイルではありません", "VALIDATION_ERROR");
    }

    // 手がかりは元のPDFから読む(縮めても文字は同じ)。大きいものは圧縮と同じ順番待ちで。
    let text = "";
    try {
      text =
        original.length > MAX_FILE_SIZE
          ? await runExclusive(() => extractTextFromPdf(original))
          : await extractTextFromPdf(original);
    } catch {
      // 文字が読めなくても受け取る(手で物件を選べる)。
      text = "";
    }
    const clues = extractReportClues(text);

    const fitted = await fitPdfToLimit(original);
    const key = reportInboxStorageKey(Date.now(), randomUUID());
    const uploaded = await getStorage().upload(fitted.buffer, {
      key,
      mimeType: "application/pdf",
      fileName: "report.pdf",
    });

    let item;
    try {
      item = await prisma.reportInboxItem.create({
        data: {
          fileName,
          fileUrl: uploaded.url,
          fileSize: fitted.buffer.length,
          originalSize: fitted.originalSize,
          source: clues.source,
          buildingName: clues.buildingName,
          roomNo: clues.roomNo,
          address: clues.address,
          uploadedBy: session.id,
        },
      });
    } catch (e) {
      // 記録が作れなかったら、置いたファイルを残さない(どこからも見えない個人情報になる)。
      await getStorage().delete(key).catch(() => {});
      throw e;
    }

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "report_inbox_items",
      targetId: item.id,
      // ⚠元のファイル名は記録しない(依頼者名を含み得る)。
      detail: {
        source: clues.source,
        ...(fitted.originalSize !== null
          ? { compressedFrom: fitted.originalSize, compressedTo: fitted.buffer.length }
          : {}),
      },
    });

    return apiResponse(
      {
        id: item.id,
        source: item.source,
        buildingName: item.buildingName,
        roomNo: item.roomNo,
        address: item.address,
        compressed: fitted.originalSize !== null,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
