import type { ConvertPinToPropertyInput } from "@/lib/validators";

/** 変換元ピンから引き継ぐ座標(Prisma Decimal を number 化したもの)。 */
export interface PinGeoSource {
  lat: number;
  lng: number;
}

/**
 * 「物件化候補」ピン + 入力から、Property 作成用の prisma data を組み立てる純関数。
 * - GPS はピンから継承(入力では受け取らない)
 * - introductionRoute は既存 allowlist 値 "field_survey"(現地調査)固定
 * - registryStatus/dmStatus/caseStatus は新規物件の既定
 */
export function buildPropertyDataFromPin(
  input: ConvertPinToPropertyInput,
  pin: PinGeoSource,
  createdBy: string,
) {
  return {
    propertyType: input.propertyType,
    address: input.address,
    postalCode: input.postalCode ?? null,
    lotNumber: input.lotNumber ?? null,
    buildingNumber: input.buildingNumber ?? null,
    realEstateNumber: input.realEstateNumber ?? null,
    introductionRoute: "field_survey",
    gpsLat: pin.lat,
    gpsLng: pin.lng,
    registryStatus: "unconfirmed" as const,
    dmStatus: "hold" as const,
    caseStatus: "new_case" as const,
    createdBy,
  };
}

/** 物件化候補ピンの写真 1 枚から PropertyPhoto 作成 data を組み立てる純関数。 */
export interface PinPhotoSource {
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedByUserId: string;
  sortOrder: number;
}

export function buildPropertyPhotoDataFromPinPhoto(
  pinPhoto: PinPhotoSource,
  propertyId: string,
  newFileUrl: string,
) {
  return {
    propertyId,
    fileUrl: newFileUrl,
    fileName: pinPhoto.fileName,
    fileSize: pinPhoto.fileSize,
    mimeType: pinPhoto.mimeType,
    // 撮影者は元の現地担当を保持(pin の uploadedByUserId → property の takenBy)。
    takenBy: pinPhoto.uploadedByUserId,
    sortOrder: pinPhoto.sortOrder,
    // thumbnailUrl / caption / gpsLat / gpsLng / takenAt / isPrimary は付けない
    // (ピンに対応列なし・GPS は引き継がない=PII安全・既定値に委ねる)。
  };
}
