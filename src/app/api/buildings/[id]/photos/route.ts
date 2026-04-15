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

// ---------- GET /api/buildings/[id]/photos ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "棟閲覧の権限がありません", "FORBIDDEN");
    }

    const building = await prisma.building.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    const photos = await prisma.buildingPhoto.findMany({
      where: { buildingId: id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        photographer: { select: { id: true, name: true } },
      },
    });

    return apiResponse({ data: photos });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- POST /api/buildings/[id]/photos ----------
// Accepts multipart/form-data with "file" (required) and "caption" (optional).

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "棟編集の権限がありません", "FORBIDDEN");
    }

    const building = await prisma.building.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!building) {
      throw new ApiError(404, "棟が見つかりません", "NOT_FOUND");
    }

    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError(
        415,
        "multipart/form-data で送信してください",
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const caption = (formData.get("caption") as string | null) ?? null;

    if (!file || !(file instanceof Blob)) {
      throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
    }

    const fileName = (file as File).name ?? "photo.jpg";
    const fileSize = file.size;
    const mimeType = file.type || "image/jpeg";

    const validationError = validateFile(fileSize, mimeType, ALLOWED_PHOTO_MIMES);
    if (validationError) {
      throw new ApiError(422, validationError, "VALIDATION_ERROR");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = fileName.split(".").pop() ?? "jpg";
    const key = `buildings/${id}/photos/${Date.now()}.${ext}`;

    const storage = getStorage();
    const result = await storage.upload(buffer, { key, mimeType, fileName });

    const maxSort = await prisma.buildingPhoto.aggregate({
      where: { buildingId: id },
      _max: { sortOrder: true },
    });
    const nextSort = (maxSort._max.sortOrder ?? -1) + 1;

    const photo = await prisma.buildingPhoto.create({
      data: {
        buildingId: id,
        fileUrl: result.url,
        thumbnailUrl: result.thumbnailUrl ?? null,
        fileName,
        fileSize,
        mimeType,
        caption: caption?.trim() || null,
        sortOrder: nextSort,
        takenBy: session.id,
      },
      include: {
        photographer: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "photo_upload",
      targetTable: "building_photos",
      targetId: photo.id,
      detail: { buildingId: id, fileName: photo.fileName },
    });

    return apiResponse({ data: photo }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
