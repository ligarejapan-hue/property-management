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
