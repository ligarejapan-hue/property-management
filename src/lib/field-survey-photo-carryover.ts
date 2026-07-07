import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { buildPropertyPhotoDataFromPinPhoto } from "@/lib/field-survey-convert";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

interface PinPhotoRow {
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedByUserId: string;
  sortOrder: number;
}

interface CarryoverDb {
  fieldSurveyPinPhoto: { findMany: (args: unknown) => Promise<PinPhotoRow[]> };
  propertyPhoto: { create: (args: unknown) => Promise<unknown> };
}

interface CarryoverStorage {
  keyFromUrl: (fileUrl: string) => string | null;
  read: (key: string) => Promise<{ body: Buffer } | null>;
  upload: (
    buf: Buffer,
    opts: { key: string; mimeType: string; fileName: string },
  ) => Promise<{ url: string; key: string }>;
  delete: (key: string) => Promise<void>;
}

interface CarryoverDeps {
  db?: CarryoverDb;
  storage?: CarryoverStorage;
  uuid?: () => string;
  now?: () => number;
}

/**
 * 物件化候補ピンの写真を新物件へ複製(コピー)する。ベストエフォート:
 * - 1 枚失敗(キー解決不可 / storage 欠損 / I/O エラー)しても残りは続行。
 * - 位置情報(GPS/EXIF)は引き継がない(複製前に必ず strip。unsupported/malformed はスキップ)。
 * - キー・座標・ファイル名はログ/監査に出さない(件数のみ返す)。
 * - 呼び出し側は変換の $transaction 成功後に非致命で await する(I/O は tx 外)。
 */
export async function copyPinPhotosToProperty(
  pinId: string,
  propertyId: string,
  deps: CarryoverDeps = {},
): Promise<{ copied: number; failed: number }> {
  const db = deps.db ?? (prisma as unknown as CarryoverDb);
  const storage = deps.storage ?? (getStorage() as unknown as CarryoverStorage);
  const uuid: () => string = deps.uuid ?? randomUUID;
  const now: () => number = deps.now ?? Date.now;

  const pinPhotos = await db.fieldSurveyPinPhoto.findMany({
    where: { pinId },
    orderBy: { sortOrder: "asc" },
    select: {
      fileUrl: true,
      fileName: true,
      fileSize: true,
      mimeType: true,
      uploadedByUserId: true,
      sortOrder: true,
    },
  });

  let copied = 0;
  let failed = 0;
  for (const p of pinPhotos) {
    // upload 済みだが create 未完のキー。create 失敗時に孤児 blob を掃除するため保持。
    let orphanKey: string | null = null;
    try {
      // active adapter の keyFromUrl で解決する。旧データの絶対 URL(server backend)も
      // lenient に解決して取りこぼさない(@codex 指摘対応。厳格な extractStorageKeyFromUrl は
      // /uploads 相対のみ受理し絶対 URL を弾くため使わない)。
      const key = storage.keyFromUrl(p.fileUrl);
      if (!key) {
        failed++;
        continue;
      }
      const file = await storage.read(key);
      if (!file) {
        failed++;
        continue;
      }
      // 旧データ(upload 時 strip 前)や retro-strip の残り(unsupported/malformed)は EXIF/GPS を
      // 保持し得る。property 側は upload 時に strip しないため、複製前に必ず strip して物件ギャラリーへの
      // EXIF/GPS 流入を防ぐ(@codex 指摘対応)。unsupported(HEIC 等)/malformed はスキップ(failed)。
      const stripped = stripFieldSurveyPhotoMetadata(file.body, p.mimeType);
      if (!stripped.ok) {
        failed++;
        continue;
      }
      const uploadBuffer = stripped.buffer;
      const ext = MIME_TO_EXT[p.mimeType] ?? "bin";
      const newKey = `properties/${propertyId}/photos/${now()}-${uuid()}.${ext}`;
      const result = await storage.upload(uploadBuffer, {
        key: newKey,
        mimeType: p.mimeType,
        fileName: p.fileName,
      });
      orphanKey = result.key; // create が成功するまでは孤児候補
      // 常に proxy 相対 URL(/uploads/{key})で保存(server backend の絶対 URL を持ち込まない)。
      const newFileUrl = `/uploads/${result.key}`;
      await db.propertyPhoto.create({
        // fileSize は strip 後の実バイト数(pins upload と同方針)。
        data: { ...buildPropertyPhotoDataFromPinPhoto(p, propertyId, newFileUrl), fileSize: uploadBuffer.length },
      });
      orphanKey = null; // DB 行が出来たので孤児ではない
      copied++;
    } catch {
      failed++;
      // upload 成功後に create が失敗した場合、DB 行の無い孤児 blob を掃除する(削除は DB 行駆動の
      // ため放置すると通常フローで回収不能。@codex 指摘対応。掃除失敗は握る=best-effort)。
      if (orphanKey) {
        try {
          await storage.delete(orphanKey);
        } catch {
          // 掃除失敗は無視(元の失敗を優先)。
        }
      }
    }
  }
  return { copied, failed };
}
