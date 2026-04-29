import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import {
  getStorage,
  validateFile,
  ALLOWED_PHOTO_MIMES,
} from "@/lib/storage";
import { normalizeFileUrlsInRecord } from "@/lib/url-normalize";

// ---------- GET /api/properties/[id]/photos ----------

export async function GET(
  _request: NextRequest,
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
      select: { id: true, createdBy: true, assignedTo: true },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    const photos = await prisma.propertyPhoto.findMany({
      where: { propertyId: id },
      orderBy: { sortOrder: "asc" },
      include: {
        photographer: { select: { id: true, name: true } },
      },
    });

    return apiResponse({ data: photos.map(normalizeFileUrlsInRecord) });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/properties/[id]/photos ----------
// Accepts multipart/form-data with a "file" field, OR JSON body for metadata-only.

export async function POST(
  request: NextRequest,
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
      select: { id: true, createdBy: true, assignedTo: true },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";

    let fileUrl = "";
    let thumbnailUrl: string | null = null;
    let fileName = "photo.jpg";
    let fileSize = 0;
    let mimeType = "image/jpeg";

    if (contentType.includes("multipart/form-data")) {
      // Real file upload via storage adapter
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof Blob)) {
        throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
      }

      fileName = (file as File).name ?? "photo.jpg";
      fileSize = file.size;
      mimeType = file.type || "image/jpeg";

      const validationError = validateFile(fileSize, mimeType, ALLOWED_PHOTO_MIMES);
      if (validationError) {
        throw new ApiError(422, validationError, "VALIDATION_ERROR");
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = fileName.split(".").pop() ?? "jpg";
      const key = `properties/${id}/photos/${Date.now()}.${ext}`;

      const storage = getStorage();
      const result = await storage.upload(buffer, { key, mimeType, fileName });
      fileUrl = result.url;
      thumbnailUrl = result.thumbnailUrl ?? null;
    } else {
      // JSON metadata-only (legacy / URL-based)
      const body = await request.json();
      fileUrl = body.url ?? body.fileUrl ?? "";
      thumbnailUrl = body.thumbnailUrl ?? null;
      fileName = body.fileName ?? body.caption ?? "photo.jpg";
      fileSize = body.fileSize ?? 0;
      mimeType = body.mimeType ?? "image/jpeg";

      if (fileSize > 0 || mimeType !== "image/jpeg") {
        const validationError = validateFile(
          fileSize || 0,
          mimeType,
          ALLOWED_PHOTO_MIMES,
        );
        if (validationError) {
          throw new ApiError(422, validationError, "VALIDATION_ERROR");
        }
      }
    }

    // Get next sort order
    const maxSort = await prisma.propertyPhoto.aggregate({
      where: { propertyId: id },
      _max: { sortOrder: true },
    });
    const nextSort = (maxSort._max.sortOrder ?? -1) + 1;

    const photo = await prisma.propertyPhoto.create({
      data: {
        propertyId: id,
        fileUrl,
        thumbnailUrl,
        fileName,
        fileSize,
        mimeType,
        takenBy: session.id,
        sortOrder: nextSort,
      },
      // GET と同じ shape で返すために photographer を include する
      // （フロントが「全件再取得」する場合のためにも、レスポンス互換性が大事）
      include: {
        photographer: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "photo_upload",
      targetTable: "property_photos",
      targetId: photo.id,
      detail: { propertyId: id, fileName: photo.fileName },
    });

    return apiResponse({ data: normalizeFileUrlsInRecord(photo) }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
