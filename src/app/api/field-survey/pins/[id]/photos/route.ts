import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { getStorage, validateFile, ALLOWED_PHOTO_MIMES } from "@/lib/storage";
import { normalizeFileUrlsInRecord } from "@/lib/url-normalize";

// ---------- /api/field-survey/pins/[id]/photos ----------
//
// Phase 1-H: 調査ピン写真。pin create → photo upload の二段階のうち後段。
// - storageKey は API レスポンスに出さない (fileUrl のみ表示用に返す)。
// - 座標 / memo / EXIF は本テーブルに無い。レスポンスにも含めない。
// - AuditLog は pin_photo_create / pin_photo_delete の操作事実 + ID のみ。
//   URL / storageKey / fileName / 座標 / memo / PII は detail に書かない。

// storage key の拡張子は元 fileName ではなく MIME type から決める。
// 許可 MIME 以外は validateFile で 422 になるため、ここに来るのは下記のみ。
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

const SELECT_PHOTO = {
  id: true,
  pinId: true,
  fileUrl: true,
  thumbnailUrl: true,
  fileName: true,
  fileSize: true,
  mimeType: true,
  sortOrder: true,
  createdAt: true,
} as const;

// ---------- POST: own pin + field_survey:write のみ。archived 不可。 ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "写真の追加権限がありません", "FORBIDDEN");
    }

    const pin = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: { id: true, staffUserId: true, status: true },
    });
    if (!pin) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    // 他人 pin への写真追加は read_all / manage を持っていても不可 (Phase 1-G/1-H 方針)。
    if (pin.staffUserId !== session.id) {
      throw new ApiError(403, "他スタッフの pin には追加できません", "FORBIDDEN");
    }
    if (pin.status === "archived") {
      throw new ApiError(
        409,
        "アーカイブ済の pin には写真を追加できません",
        "INVALID_STATE",
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError(
        422,
        "multipart/form-data で送信してください",
        "VALIDATION_ERROR",
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
    }

    const fileName = (file as File).name || "photo.jpg";
    const fileSize = file.size;
    // MIME type の fallback は禁止。Content-Type が空 / 未指定の part は拒否する
    // (拡張子だけで画像と信用しない)。実際の file.type を validateFile に渡す。
    const mimeType = file.type;
    if (!mimeType) {
      throw new ApiError(
        422,
        "ファイル形式 (Content-Type) が指定されていません",
        "VALIDATION_ERROR",
      );
    }

    const validationError = validateFile(fileSize, mimeType, ALLOWED_PHOTO_MIMES);
    if (validationError) {
      throw new ApiError(422, validationError, "VALIDATION_ERROR");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // 拡張子は MIME type から決定 (元 fileName の拡張子は信用しない)。
    // key には randomUUID を含め、同一 pin / 同一ミリ秒 upload でも衝突しない。
    const ext = MIME_TO_EXT[mimeType] ?? "bin";
    const key = `field-survey/pins/${id}/photos/${randomUUID()}.${ext}`;

    const storage = getStorage();
    const result = await storage.upload(buffer, { key, mimeType, fileName });

    const maxSort = await prisma.fieldSurveyPinPhoto.aggregate({
      where: { pinId: id },
      _max: { sortOrder: true },
    });
    const nextSort = (maxSort._max.sortOrder ?? -1) + 1;

    const photo = await prisma.fieldSurveyPinPhoto.create({
      data: {
        pinId: id,
        fileUrl: result.url,
        thumbnailUrl: result.thumbnailUrl ?? null,
        fileName,
        fileSize,
        mimeType,
        uploadedByUserId: session.id,
        sortOrder: nextSort,
      },
      select: SELECT_PHOTO,
    });

    await writeAuditLog({
      userId: session.id,
      action: "field_survey_pin_photo_create",
      targetTable: "field_survey_pin_photos",
      targetId: photo.id,
      detail: { pinId: id, photoId: photo.id },
    });

    return apiResponse({ data: normalizeFileUrlsInRecord(photo) }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- GET: own は read / 他人は read_all または manage ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const pin = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: { id: true, staffUserId: true },
    });
    if (!pin) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = pin.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(403, "他スタッフの pin は閲覧できません", "FORBIDDEN");
    }

    const photos = await prisma.fieldSurveyPinPhoto.findMany({
      where: { pinId: id },
      orderBy: { sortOrder: "asc" },
      select: SELECT_PHOTO,
    });

    return apiResponse({ data: photos.map(normalizeFileUrlsInRecord) });
  } catch (error) {
    return handleApiError(error);
  }
}
