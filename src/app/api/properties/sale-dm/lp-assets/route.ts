import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage, validateFile, MAX_FILE_SIZE } from "@/lib/storage";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";
import { readImageDimensions } from "@/lib/image-dimensions";
import { requireSaleDmAccess, requireSaleDmWriteAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmLpAssetLabelSchema } from "@/lib/validators-sale-dm";

/** LP用の写真ライブラリ(設計 2026-09-08 §2.3)。全キャンペーン共通。 */
export const LP_ASSET_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const LP_ASSET_MAX_EDGE = 1600;
const MIME_TO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const SELECT = { id: true, publicId: true, mime: true, width: true, height: true, bytes: true, label: true, createdAt: true } as const;

// クライアントに返す項目の許可リスト。DB 層の select は実運用では効くが、mime/storageKey 等の
// 内部項目を取り違えて select し忘れても storageKey/createdBy を絶対に漏らさないよう、
// レスポンス組み立てでも明示的に拾う(spread しない)。
type AssetRow = {
  id: string;
  publicId: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  label: string | null;
  createdAt: Date;
};
function toPublicAsset(a: AssetRow, referenced: boolean) {
  return {
    id: a.id,
    publicId: a.publicId,
    mime: a.mime,
    width: a.width,
    height: a.height,
    bytes: a.bytes,
    label: a.label,
    createdAt: a.createdAt,
    referenced,
  };
}

export async function GET(_req: NextRequest) {
  try {
    await requireSaleDmAccess();
    const rows = await prisma.dmLpAsset.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { ...SELECT, _count: { select: { media: true } } },
    });
    const assets = rows.map((r) => toPublicAsset(r, r._count.media > 0));
    return NextResponse.json({ assets }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError(422, "画像は multipart/form-data で送信してください", "VALIDATION_ERROR");
    }
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) throw new ApiError(422, "ファイルが必要です", "VALIDATION_ERROR");
    const labelRaw = formData.get("label");
    const label = typeof labelRaw === "string" && labelRaw.trim() !== "" ? saleDmLpAssetLabelSchema.parse(labelRaw) : null;

    const mimeType = file.type;
    if (!LP_ASSET_MIMES.has(mimeType)) {
      throw new ApiError(422, "JPEG / PNG / WebP の画像を使用してください(HEIC は画面側で変換されます)", "VALIDATION_ERROR");
    }
    const sizeIssue = validateFile(file.size, mimeType, LP_ASSET_MIMES);
    if (sizeIssue) throw new ApiError(422, sizeIssue, "VALIDATION_ERROR");

    const raw = Buffer.from(await file.arrayBuffer());
    // 保存前に EXIF(位置情報を含む)を除く。失敗は fail-closed。
    const stripped = stripFieldSurveyPhotoMetadata(raw, mimeType);
    if (!stripped.ok) throw new ApiError(422, "画像ファイルを処理できませんでした", "VALIDATION_ERROR");
    const buffer = stripped.buffer;
    if (buffer.length > MAX_FILE_SIZE) throw new ApiError(422, "ファイルサイズが上限を超えています", "VALIDATION_ERROR");

    const dims = readImageDimensions(buffer, mimeType);
    if (!dims) throw new ApiError(422, "画像の大きさを読み取れませんでした", "VALIDATION_ERROR");
    if (Math.max(dims.width, dims.height) > LP_ASSET_MAX_EDGE) {
      throw new ApiError(422, `画像の長辺は ${LP_ASSET_MAX_EDGE}px 以下にしてください(画面から登録すると自動で縮小されます)`, "VALIDATION_ERROR");
    }

    const key = `lp-assets/${randomUUID()}.${MIME_TO_EXT[mimeType]}`;
    const storage = getStorage();
    const stored = await storage.upload(buffer, { key, mimeType, fileName: `lp-asset.${MIME_TO_EXT[mimeType]}` });

    let asset;
    try {
      asset = await prisma.dmLpAsset.create({
        data: {
          publicId: randomBytes(16).toString("hex"),
          storageKey: stored.key,
          mime: mimeType,
          width: dims.width,
          height: dims.height,
          bytes: buffer.length,
          label,
          createdBy: session.id,
        },
        select: SELECT,
      });
    } catch (dbError) {
      try { await storage.delete(stored.key); } catch { /* best-effort */ }
      throw dbError;
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_asset_upload",
      targetTable: "dm_lp_assets",
      targetId: asset.id,
      // 非PII: 寸法・バイト数・日時のみ(ファイル名・ラベルは載せない)。
      detail: { bytes: buffer.length, width: dims.width, height: dims.height, uploadedAt: new Date().toISOString() },
    });
    return NextResponse.json({ asset: toPublicAsset(asset, false) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
