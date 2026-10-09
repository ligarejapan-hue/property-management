import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import {
  getStorage,
  validateFile,
  ALLOWED_ATTACHMENT_MIMES,
} from "@/lib/storage";
import { normalizeFileUrlsInRecord } from "@/lib/url-normalize";
import { assertImportJsonBodySize, assertImportMultipartBodySize } from "@/lib/import-body-size";
import {
  MAX_PDF_UPLOAD_BYTES,
  isPdfByMimeOrName,
  pdfTooLargeToAcceptMessage,
} from "@/lib/pdf-compress/policy";
import { fitPdfToLimit, reserveLargePdfSlot } from "@/lib/pdf-compress/fit";
import { isPdfBuffer } from "@/lib/pdf-extract";

const ATTACHMENT_TYPES = ["general", "registry"] as const;
type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

const registerAttachmentSchema = z.object({
  fileName: z.string().min(1, "ファイル名は必須です"),
  fileUrl: z.string().min(1, "ファイルURLは必須です"),
  fileSize: z.number().int().min(0, "ファイルサイズは0以上です"),
  mimeType: z.string().min(1, "MIMEタイプは必須です"),
  type: z.enum(ATTACHMENT_TYPES).optional(),
});

function normalizeAttachmentType(raw: unknown): AttachmentType {
  if (typeof raw === "string" && (ATTACHMENT_TYPES as readonly string[]).includes(raw)) {
    return raw as AttachmentType;
  }
  return "general";
}

// ---------- GET /api/properties/:id/attachments ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // field_staff スコープ: 担当外の物件は閲覧不可（物件詳細 API と同じ判定を共有）
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    const attachments = await prisma.attachment.findMany({
      where: {
        targetType: "property",
        targetId: propertyId,
        isDeleted: false,
      },
      include: {
        uploader: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // 過去保存の絶対URL（http://host:3000/uploads/...）を相対パスに正規化
    return apiResponse({ data: attachments.map(normalizeFileUrlsInRecord) });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/properties/:id/attachments ----------
// Accepts multipart/form-data with "file" field, OR JSON for metadata-only.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";

    let fileName: string;
    let fileUrl: string;
    let fileSize: number;
    let mimeType: string;
    let attachmentType: AttachmentType = "general";
    let originalSize: number | null = null;

    if (contentType.includes("multipart/form-data")) {
      // ⚠formData() はボディ全体をメモリに読む。大きいPDF(自動圧縮の対象)を受けるので、
      //   読む前に Content-Length で上限(50MB)を見る(取込系と同じ守り方)。
      assertImportMultipartBodySize(request, MAX_PDF_UPLOAD_BYTES);
      // 圧縮が要るかもしれない大きさなら、本文を読む前に圧縮の席を取る(埋まっていれば 503)。
      releaseSlot = reserveLargePdfSlot(request);
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof Blob)) {
        throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
      }

      attachmentType = normalizeAttachmentType(formData.get("type"));

      fileName = (file as File).name ?? "file";
      fileSize = file.size;
      mimeType = file.type || "application/octet-stream";

      // 空ファイル拒否（拡張子だけのプレースホルダ等を防ぐ）
      if (fileSize <= 0) {
        throw new ApiError(422, "空ファイルはアップロードできません", "VALIDATION_ERROR");
      }

      // 謄本PDFは PDF のみ許可（MIME or 拡張子フォールバック）
      if (attachmentType === "registry") {
        const isPdfMime = mimeType === "application/pdf";
        const isPdfExt = fileName.toLowerCase().endsWith(".pdf");
        if (!isPdfMime && !isPdfExt) {
          throw new ApiError(
            422,
            "謄本PDFは PDF ファイルのみアップロードできます",
            "VALIDATION_ERROR",
          );
        }
        // MIME が空/octet-stream で来ても拡張子で PDF と判定された場合は補正
        if (!isPdfMime && isPdfExt) {
          mimeType = "application/pdf";
        }
      }

      // 通常の添付も、MIME が空・不明で拡張子が .pdf なら PDF として扱う(@codex PR#498 P2)。
      //   ⚠中身が本当に PDF かは、読んだ後に先頭の %PDF- で確かめる(下)。
      const pdfByName = attachmentType !== "registry" && mimeType !== "application/pdf" &&
        isPdfByMimeOrName(mimeType, fileName);
      if (pdfByName) mimeType = "application/pdf";

      // ⚠**謄本以外の PDF** は、上限(8MB)を超えていたら自動で縮める(発注者決定 2026-10-09)。
      //   謄本は課金して取った原本なので縮めない=従来どおり 8MB で断る。
      //   上限以下の PDF には手を触れない。圧縮前の原本は残さない(決定)。
      const compressible = attachmentType !== "registry" && mimeType === "application/pdf";
      if (compressible && fileSize > MAX_PDF_UPLOAD_BYTES) {
        throw new ApiError(422, pdfTooLargeToAcceptMessage(), "VALIDATION_ERROR");
      }

      const validate = () => {
        const validationError = validateFile(fileSize, mimeType, ALLOWED_ATTACHMENT_MIMES);
        if (validationError) {
          throw new ApiError(422, validationError, "VALIDATION_ERROR");
        }
      };
      // 縮めないもの(謄本・PDF以外)は、これまでどおり読む前に断る。
      if (!compressible) validate();

      let buffer: Buffer = Buffer.from(await file.arrayBuffer());
      if (pdfByName && !isPdfBuffer(buffer)) {
        throw new ApiError(422, "PDFファイルではありません", "VALIDATION_ERROR");
      }
      if (compressible) {
        const fitted = await fitPdfToLimit(buffer);
        buffer = fitted.buffer;
        fileSize = buffer.length;
        originalSize = fitted.originalSize;
        // 大きさの検査は**縮めた後**の実物で行う。
        validate();
      }

      const ext = fileName.split(".").pop() ?? "bin";
      const subdir = attachmentType === "registry" ? "registry" : "attachments";
      // key に randomUUID を含め、同一物件・同一ミリ秒の upload でも衝突しない
      // （general / registry とも。key 非再利用は /uploads の key 由来 ETag/304 の
      //   前提であり、registry でも同一ms衝突による storage 上書きを防ぐ。
      //   registry の配信方針(no-store/generic filename/監査)はここでは不変）。
      const key = `properties/${propertyId}/${subdir}/${Date.now()}-${randomUUID()}.${ext}`;

      const storage = getStorage();
      const result = await storage.upload(buffer, { key, mimeType, fileName });
      fileUrl = result.url;
    } else {
      // ⚠この口は proxy を通らない(大きいPDFのため・src/proxy.ts)ので、JSON も
      //   読む前に大きさを見る(メタ情報だけなので 64KB で十分)。
      assertImportJsonBodySize(request, 64 * 1024);
      const body = await request.json();
      const data = registerAttachmentSchema.parse(body);
      fileName = data.fileName;
      fileUrl = data.fileUrl;
      fileSize = data.fileSize;
      mimeType = data.mimeType;
      attachmentType = normalizeAttachmentType(data.type);

      if (attachmentType === "registry" && mimeType !== "application/pdf") {
        throw new ApiError(
          422,
          "謄本PDFは PDF ファイルのみアップロードできます",
          "VALIDATION_ERROR",
        );
      }

      const validationError = validateFile(fileSize, mimeType, ALLOWED_ATTACHMENT_MIMES);
      if (validationError) {
        throw new ApiError(422, validationError, "VALIDATION_ERROR");
      }
    }

    // ⚠**親の物件行をロックしてから作る**(@codex #399 R7 P2 → #402)。
    //   有料取得の二重課金ガードは購入ロックの where で「謄本PDFが無いこと」を
    //   検査する。この route はロック無しの単独 create だったため、**作成が確定する
    //   直前のミリ秒**に検査が通り二重課金の余地が残っていた(型が registry の場合)。
    //   ⚠registry 以外の添付も同じ扱いにする=「物件配下を書き換える tx は親を先に
    //   ロック」の書き込み規約(#364)に全 type で揃える。ロックは作成の一瞬だけ。
    const attachment = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, propertyId);
      return tx.attachment.create({
        data: {
          targetType: "property",
          targetId: propertyId,
          propertyId,
          type: attachmentType,
          fileName,
          fileUrl,
          fileSize,
          originalSize,
          mimeType,
          uploadedBy: session.id,
        },
        include: {
          uploader: { select: { id: true, name: true } },
        },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "attachments",
      targetId: attachment.id,
      detail: {
        propertyId,
        fileName,
        ...(originalSize !== null ? { compressedFrom: originalSize, compressedTo: fileSize } : {}),
      },
    });

    return apiResponse(normalizeFileUrlsInRecord(attachment), 201);
  } catch (error) {
    return handleApiError(error);
  } finally {
    releaseSlot();
  }
}
