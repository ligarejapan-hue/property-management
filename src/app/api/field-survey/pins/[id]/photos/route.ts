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
import { touchTripActivity } from "@/lib/field-survey-auto-end";
import { getStorage, validateFile, ALLOWED_PHOTO_MIMES } from "@/lib/storage";
import { extractStorageKeyFromUrl } from "@/lib/storage/url-to-key";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";
import { normalizeFileUrl, normalizeFileUrlsInRecord } from "@/lib/url-normalize";

// storage key を app proxy 経由の相対 URL にする。絶対 URL / public URL は保存しない。
// leading slash / duplicate slash / backslash を正規化する (空 key は呼び出し側で来ない)。
function toUploadProxyUrl(key: string): string {
  const clean = String(key)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  return `/uploads/${clean}`;
}

// thumbnail は専用 key を持たないため、proxy 相対 (/uploads/...) に正規化できる場合のみ
// 保持する。storage server 直 URL 等は保存せず null に倒す (絶対 URL を DB に残さない)。
function toProxyThumbnailUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const normalized = normalizeFileUrl(raw);
  return normalized.startsWith("/uploads/") ? normalized : null;
}

// ---------- /api/field-survey/pins/[id]/photos ----------
//
// Phase 1-H: 調査ピン写真。pin create → photo upload の二段階のうち後段。
// - storageKey は API レスポンスに出さない (fileUrl のみ表示用に返す)。
// - 座標 / memo / EXIF は本テーブルに無い。レスポンスにも含めない。
// - AuditLog は pin_photo_create / pin_photo_delete の操作事実 + ID のみ。
//   URL / storageKey / fileName / 座標 / memo / PII は detail に書かない。
// - 保存前に EXIF/GPS strip (stripFieldSurveyPhotoMetadata) を必ず通す。
//   HEIC/HEIF と構造不正は 422 (fail-closed)。本 route 限定で、PropertyPhoto /
//   BuildingPhoto / attachments には適用しない。
//   詳細: docs/field-survey-photo-privacy-checklist.md §5/§6

// storage key の拡張子は元 fileName ではなく MIME type から決める。
// 許可 MIME 以外は validateFile で 422 になるため、ここに来るのは下記のみ。
// (heic/heif は ALLOWED_PHOTO_MIMES に残るが、本 route では EXIF strip 未対応のため
//  strip 段階で 422 になり key 生成まで到達しない。共有定数は変更しない。)
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
      // sessionId: アップロードの前に巡回へ心拍を打つために読む(下記)。
      select: { id: true, staffUserId: true, status: true, sessionId: true },
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

    // ⚠**保存より前に一度、巡回へ心拍を打つ**(@codex #356 P2)。写真は EXIF の
    // 除去とアップロードに時間がかかるため、1時間の境目でシャッターを切ると、
    // その処理の最中に見回りが走って**撮っている最中の巡回が終了させられる**
    // (後段の心拍は 0 行更新で黙って終わるので、気づかないまま終了が成立する)。
    // ここで先に活動として数えれば、見回りの対象から外れる。
    // best-effort: 終了済みの巡回のピンに後から足すのは正常な操作なので throw しない。
    await touchTripActivity(prisma, pin.sessionId);

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

    // 保存前 EXIF/GPS strip (PR #142 の pure utility・本 route 限定)。
    // - image/heic / image/heif は strip 未対応のため 422 (docs §6 で決定済)。
    // - 構造不正 (malformed) は fail-closed で 422 (原本をそのまま保存しない)。
    // - エラーメッセージは fileName / key / 座標を含まない汎用文言のみ。
    const stripResult = stripFieldSurveyPhotoMetadata(buffer, mimeType);
    if (!stripResult.ok) {
      if (stripResult.reason === "unsupported_mime") {
        throw new ApiError(
          422,
          "この画像形式は現地調査写真では現在サポートされていません。JPEG / PNG / WebP を使用してください。",
          "VALIDATION_ERROR",
        );
      }
      throw new ApiError(
        422,
        "画像ファイルを処理できませんでした。",
        "VALIDATION_ERROR",
      );
    }
    // storage には strip 後の buffer のみを渡す (原本 buffer は保存しない)。
    const uploadBuffer = stripResult.buffer;

    // 拡張子は MIME type から決定 (元 fileName の拡張子は信用しない)。
    // key には randomUUID を含め、同一 pin / 同一ミリ秒 upload でも衝突しない。
    const ext = MIME_TO_EXT[mimeType] ?? "bin";
    const key = `field-survey/pins/${id}/photos/${randomUUID()}.${ext}`;

    const storage = getStorage();
    const result = await storage.upload(uploadBuffer, { key, mimeType, fileName });

    // Codex P1: backend (例 server adapter) は絶対 URL を result.url で返しうる。
    // 絶対 URL を DB に保存すると /uploads 認可 proxy を迂回し、DELETE 時の
    // key 復元 (extractStorageKeyFromUrl) も絶対 URL を弾く。常に proxy 相対 URL
    // (= /uploads/{key}) を保存し、thumbnail も proxy 相対化できる場合のみ保持する。
    const proxyFileUrl = toUploadProxyUrl(result.key);
    const proxyThumbnailUrl = toProxyThumbnailUrl(result.thumbnailUrl);

    // ⚠冒頭の archived チェックは check-then-write で、検証と INSERT のすき間に
    // ピンが archive されると**アーカイブ済みピンに写真が付く**（UI から見えない
    // 場所に入る・総点検P3）。同一 tx 内でピン行を条件付き touch し、0 行なら
    // 409 で rollback する。touch がピン行をロックするため、同一ピンへの並行
    // 写真追加も直列化され sortOrder の重複も出ない。
    let photo;
    try {
      photo = await prisma.$transaction(async (tx) => {
        const guard = await tx.fieldSurveyPin.updateMany({
          where: { id, status: { not: "archived" } },
          data: { updatedAt: new Date() },
        });
        if (guard.count === 0) {
          throw new ApiError(
            409,
            "アーカイブ済みのピンには写真を追加できません",
            "INVALID_STATE",
          );
        }
        // ⚠**写真の追加も巡回の活動として数える**(@codex #356 P2)。ここは従来
        // ピン行しか更新しておらず、**写真を撮り続けている巡回が無操作扱い**に
        // なって自動終了(1時間)で切られてしまう。撮って登録だけで回る使い方が
        // 主動線なので、ここが抜けると自動終了そのものが現場で使えない。
        // best-effort: 終了済みの巡回のピンに後から写真を足すのは正常な操作。
        const owner = await tx.fieldSurveyPin.findUnique({
          where: { id },
          select: { sessionId: true },
        });
        await touchTripActivity(tx, owner?.sessionId);
        const maxSort = await tx.fieldSurveyPinPhoto.aggregate({
          where: { pinId: id },
          _max: { sortOrder: true },
        });
        const nextSort = (maxSort._max.sortOrder ?? -1) + 1;
        return tx.fieldSurveyPinPhoto.create({
          data: {
            pinId: id,
            fileUrl: proxyFileUrl,
            thumbnailUrl: proxyThumbnailUrl,
            fileName,
            // 保存実体は strip 後 buffer のため、そのサイズを記録する
            // (PNG/WebP は chunk drop で縮み得る。JPEG zero-fill は長さ不変)。
            fileSize: uploadBuffer.length,
            mimeType,
            uploadedByUserId: session.id,
            sortOrder: nextSort,
          },
          select: SELECT_PHOTO,
        });
      });
    } catch (txError) {
      // rollback 時は直前に upload した実体を best-effort で回収する
      // （key は randomUUID 入りでこのリクエスト専用 = 共有され得ない）。
      // ⚠backend が別実体の thumbnail を返す場合はそれも回収する (@codex #337)。
      //   DB 行が残らないため、ここで消さないと後から発見する手段が無い
      //   （通常の写真 DELETE は本体+thumbnail の両方を消すのと同じ扱い）。
      //   key の復元は DELETE 経路と同じ extractStorageKeyFromUrl（proxy 相対のみ
      //   受け付け・復元不能な形式は skip = 誤爆防止）。
      // 失敗しても応答は変えない（DB が source of truth・orphan は残るだけ）。
      const thumbnailKey = extractStorageKeyFromUrl(proxyThumbnailUrl);
      for (const key of [result.key, thumbnailKey]) {
        if (key == null) continue;
        try {
          await storage.delete(key);
        } catch {
          // best-effort（key/fileName は console に出さない既存 PII ルール）
        }
      }
      throw txError;
    }

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
