import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { buildPropertyPhotoDataFromPinPhoto } from "@/lib/field-survey-convert";

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
 * - 位置情報(GPS)は引き継がない(ピンに列なし・EXIF は元 upload 時に strip 済)。
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
      const ext = MIME_TO_EXT[p.mimeType] ?? "bin";
      const newKey = `properties/${propertyId}/photos/${now()}-${uuid()}.${ext}`;
      const result = await storage.upload(file.body, {
        key: newKey,
        mimeType: p.mimeType,
        fileName: p.fileName,
      });
      // 常に proxy 相対 URL(/uploads/{key})で保存する(server backend が返し得る
      // 絶対 URL を持ち込まない。pins photo route と同方針)。
      const newFileUrl = `/uploads/${result.key}`;
      await db.propertyPhoto.create({
        data: buildPropertyPhotoDataFromPinPhoto(p, propertyId, newFileUrl),
      });
      copied++;
    } catch {
      failed++;
    }
  }
  return { copied, failed };
}
