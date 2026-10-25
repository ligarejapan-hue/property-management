import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { lockPropertyRecordForWrite } from "@/lib/property-record-guard";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { getStorage } from "@/lib/storage";
import { normalizeFileUrlsInRecord } from "@/lib/url-normalize";
import { assertImportMultipartBodySize } from "@/lib/import-body-size";
import { MAX_ATTACHMENT_BYTES } from "@/lib/pdf-compress/policy";
import { tryReserveCompressionSlot } from "@/lib/pdf-compress/run";
import { docColumnsForNewAttachment } from "@/lib/doc-classify/assign";
import { MAX_SCAN_PAGES } from "@/lib/doc-scan/pages";
import { buildScanPdf } from "@/lib/doc-scan/run";
import { MAX_SCAN_BODY_BYTES, MAX_SCAN_PAGE_BYTES, scanFileName, sniffImage } from "@/lib/doc-scan/upload";

// ---------- POST /api/properties/:id/attachments/scan ----------
// 書類を撮る(第3段・2026-10-25): スマホで撮って紙の形に直した画像(multipart の "page" を並び順に
// 1〜30枚)を1つの PDF にまとめ、先頭ページの文字を読んで種類を判別し、通常の添付として入れる。
// ⚠この口は proxy を通らない(30枚で 10MB を超えうる・src/proxy.ts)=認証 → 大きさの確認 → 本文の順。
// ⚠読み取った文字は判別に使うだけ。保存しない・ログや監査に出さない。

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
      select: { id: true, createdBy: true, assignedTo: true, buildingName: true, roomNo: true, address: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    assertImportMultipartBodySize(request, MAX_SCAN_BODY_BYTES);
    // PDF にまとめる処理は重いので、大きい PDF の圧縮と同じ席を取る(埋まっていれば本文を読まずに断る)。
    const release = tryReserveCompressionSlot();
    if (!release) {
      throw new ApiError(503, "ほかの書類を処理中です。少し待ってからもう一度お試しください", "BUSY");
    }
    releaseSlot = release;

    const formData = await request.formData();
    const parts = formData.getAll("page");
    if (parts.length < 1 || parts.length > MAX_SCAN_PAGES) {
      throw new ApiError(422, `撮った書類は1〜${MAX_SCAN_PAGES}枚で送ってください`, "VALIDATION_ERROR");
    }
    const pages: Buffer[] = [];
    for (const part of parts) {
      if (!(part instanceof Blob) || part.size <= 0 || part.size > MAX_SCAN_PAGE_BYTES) {
        throw new ApiError(422, "撮った書類の画像が読めませんでした", "VALIDATION_ERROR");
      }
      const buf = Buffer.from(await part.arrayBuffer());
      if (!sniffImage(buf)) {
        throw new ApiError(422, "撮った書類の画像が読めませんでした", "VALIDATION_ERROR");
      }
      pages.push(buf);
    }

    const scan = await buildScanPdf(pages);
    if (!scan.ok) {
      if (scan.reason === "unavailable") {
        throw new ApiError(503, "この環境では書類を PDF にできません", "UNAVAILABLE");
      }
      if (scan.reason === "invalid_image" || scan.reason === "too_many_pages") {
        throw new ApiError(422, "撮った書類の画像が読めませんでした", "VALIDATION_ERROR");
      }
      throw new ApiError(500, "PDF にできませんでした。もう一度お試しください", "SCAN_FAILED");
    }
    if (scan.pdf.length > MAX_ATTACHMENT_BYTES) {
      throw new ApiError(422, "PDF が大きすぎます。枚数を分けて撮ってください", "VALIDATION_ERROR");
    }

    const fileName = scanFileName(new Date());
    const key = `properties/${propertyId}/attachments/${Date.now()}-${randomUUID()}.pdf`;
    const storage = getStorage();
    const stored = await storage.upload(scan.pdf, { key, mimeType: "application/pdf", fileName });

    // 通常の添付と同じく、親の物件行をロックしてから作る(名前の連番を同時の登録とぶつけない)。
    // 作れなかったときは、先に置いたファイルを消す(持ち主のいないファイルを残さない)。
    const attachment = await prisma.$transaction(async (tx) => {
      // ⚠PDF にして読むあいだ(最大2分)に担当から外れた人には作らせない=ロックの中で担当範囲を見直す(@codex #594 P2)。
      await lockPropertyRecordForWrite(tx, propertyId, session);
      const existing = await tx.attachment.findMany({
        where: { targetType: "property", targetId: propertyId, isDeleted: false, docTitle: { not: null } },
        select: { docTitle: true },
      });
      const docColumns = docColumnsForNewAttachment(
        { fileName, text: scan.text },
        {
          property: { buildingName: property.buildingName, roomNo: property.roomNo, address: property.address },
          takenTitles: new Set(existing.map((e) => e.docTitle).filter((t): t is string => t !== null)),
        },
      );
      return tx.attachment.create({
        data: {
          targetType: "property",
          targetId: propertyId,
          propertyId,
          type: "general",
          fileName,
          fileUrl: stored.url,
          fileSize: scan.pdf.length,
          mimeType: "application/pdf",
          uploadedBy: session.id,
          ...docColumns,
        },
        include: { uploader: { select: { id: true, name: true } } },
      });
    }).catch(async (err: unknown) => {
      try {
        await storage.delete(key);
      } catch {
        // 消せなくても元のエラーを返す。
      }
      throw err;
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "attachments",
      targetId: attachment.id,
      detail: { propertyId, fileName, scannedPages: scan.pages },
    });

    return apiResponse(
      {
        ...normalizeFileUrlsInRecord(attachment),
        scan: { pages: scan.pages, ocr: scan.ocr, ocrChars: scan.ocrChars },
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
