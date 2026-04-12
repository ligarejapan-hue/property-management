import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import {
  getStorage,
  validateFile,
  ALLOWED_ATTACHMENT_MIMES,
} from "@/lib/storage";

const registerAttachmentSchema = z.object({
  fileName: z.string().min(1, "ファイル名は必須です"),
  fileUrl: z.string().min(1, "ファイルURLは必須です"),
  fileSize: z.number().int().min(0, "ファイルサイズは0以上です"),
  mimeType: z.string().min(1, "MIMEタイプは必須です"),
});

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

    return apiResponse({ data: attachments });
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
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    const contentType = request.headers.get("content-type") ?? "";

    let fileName: string;
    let fileUrl: string;
    let fileSize: number;
    let mimeType: string;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof Blob)) {
        throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
      }

      fileName = (file as File).name ?? "file";
      fileSize = file.size;
      mimeType = file.type || "application/octet-stream";

      const validationError = validateFile(fileSize, mimeType, ALLOWED_ATTACHMENT_MIMES);
      if (validationError) {
        throw new ApiError(422, validationError, "VALIDATION_ERROR");
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = fileName.split(".").pop() ?? "bin";
      const key = `properties/${propertyId}/attachments/${Date.now()}.${ext}`;

      const storage = getStorage();
      const result = await storage.upload(buffer, { key, mimeType, fileName });
      fileUrl = result.url;
    } else {
      const body = await request.json();
      const data = registerAttachmentSchema.parse(body);
      fileName = data.fileName;
      fileUrl = data.fileUrl;
      fileSize = data.fileSize;
      mimeType = data.mimeType;

      const validationError = validateFile(fileSize, mimeType, ALLOWED_ATTACHMENT_MIMES);
      if (validationError) {
        throw new ApiError(422, validationError, "VALIDATION_ERROR");
      }
    }

    const attachment = await prisma.attachment.create({
      data: {
        targetType: "property",
        targetId: propertyId,
        propertyId,
        fileName,
        fileUrl,
        fileSize,
        mimeType,
        uploadedBy: session.id,
      },
      include: {
        uploader: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "attachments",
      targetId: attachment.id,
      detail: { propertyId, fileName },
    });

    return apiResponse(attachment, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
