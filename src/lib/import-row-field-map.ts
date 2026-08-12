/**
 * 取込エラー行の「編集して作成」と「再試行」が共有する、rawData → モデル項目の対応表。
 *
 * ⚠この2つの route は元は**完全なコピペ重複**だった。列が増えるたびに片方だけ直す
 *   事故（片方の画面からだけ値が入らない）を防ぐため、正本をここ1か所にする。
 */
import { normalizeCaseStatusInput, normalizeIntroductionRouteInput } from "@/lib/property-types";

/** Map Japanese CSV header names to property model field names. */
export const JAPANESE_FIELD_MAP: Record<string, string> = {
  "住所": "address",
  "地番": "lotNumber",
  "家屋番号": "buildingNumber",
  "不動産番号": "realEstateNumber",
  "種別": "propertyType",
  "登記状況": "registryStatus",
  "DM判断": "dmStatus",
  "案件ステータス": "caseStatus",
  "導入ルート": "introductionRoute",
  "流入経路": "introductionRoute",
  "獲得経路": "introductionRoute",
  "introduction_route": "introductionRoute",
  "acquisitionRoute": "introductionRoute",
  "acquisition_route": "introductionRoute",
  "leadSource": "introductionRoute",
  "lead_source": "introductionRoute",
  "用途地域": "zoningDistrict",
  "路線価": "rosenkaValue",
  "緯度": "gpsLat",
  "経度": "gpsLng",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

/** Map Japanese CSV header names to owner model field names. */
export const JAPANESE_OWNER_FIELD_MAP: Record<string, string> = {
  "氏名": "name",
  "氏名カナ": "nameKana",
  "電話番号": "phone",
  "郵便番号": "zip",
  "住所": "address",
  // ⚠現住所（引っ越し済みで登記が未変更の人の、実際に届く住所）。
  "現住所": "currentAddress",
  "現住所郵便番号": "currentZip",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

/**
 * Resolve a rawData key to a property model field name.
 * Tries direct match first (already an English field name), then Japanese lookup.
 */
export function resolvePropertyField(key: string): string | undefined {
  const directFields = new Set([
    "address", "lotNumber", "buildingNumber", "realEstateNumber",
    "propertyType", "registryStatus", "dmStatus", "caseStatus",
    "introductionRoute", "zoningDistrict", "rosenkaValue", "gpsLat", "gpsLng",
    "note", "externalLinkKey",
  ]);
  if (directFields.has(key)) return key;
  return JAPANESE_FIELD_MAP[key];
}

/**
 * Resolve a rawData key to an owner model field name.
 */
export function resolveOwnerField(key: string): string | undefined {
  const directFields = new Set([
    "name", "nameKana", "phone", "zip", "address",
    "currentZip", "currentAddress",
    "note", "externalLinkKey",
  ]);
  if (directFields.has(key)) return key;
  return JAPANESE_OWNER_FIELD_MAP[key];
}

/**
 * rawData を所有者の項目名へ読み替える（空値は落とす）。
 * 作成にも「既存所有者の空欄補完」にも同じ読み替えを使うために切り出してある。
 */
export function mapOwnerRawData(
  data: Record<string, string>,
): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = resolveOwnerField(key);
    if (field && value) {
      mapped[field] = value;
    }
  }
  return mapped;
}

/**
 * Build property create data from a raw data record.
 */
export function buildPropertyCreateData(
  data: Record<string, string>,
  createdBy: string,
): Record<string, unknown> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = resolvePropertyField(key);
    if (field && value) {
      mapped[field] = value;
    }
  }

  if (!mapped.address) {
    throw new Error("住所が空です");
  }

  const createData: Record<string, unknown> = {
    address: mapped.address,
    propertyType: mapped.propertyType || "unknown",
    registryStatus: mapped.registryStatus || "unconfirmed",
    dmStatus: mapped.dmStatus || "hold",
    caseStatus: normalizeCaseStatusInput(mapped.caseStatus) ?? "new_case",
    createdBy,
  };
  const normalizedRoute = normalizeIntroductionRouteInput(mapped.introductionRoute);
  if (normalizedRoute) createData.introductionRoute = normalizedRoute;
  if (mapped.lotNumber) createData.lotNumber = mapped.lotNumber;
  if (mapped.buildingNumber) createData.buildingNumber = mapped.buildingNumber;
  if (mapped.realEstateNumber) createData.realEstateNumber = mapped.realEstateNumber;
  if (mapped.externalLinkKey) createData.externalLinkKey = mapped.externalLinkKey;
  if (mapped.zoningDistrict) createData.zoningDistrict = mapped.zoningDistrict;
  if (mapped.rosenkaValue) createData.rosenkaValue = parseFloat(mapped.rosenkaValue) || null;
  if (mapped.gpsLat) createData.gpsLat = parseFloat(mapped.gpsLat) || null;
  if (mapped.gpsLng) createData.gpsLng = parseFloat(mapped.gpsLng) || null;
  if (mapped.note) createData.note = mapped.note;

  return createData;
}

/**
 * Build owner create data from a raw data record.
 */
export function buildOwnerCreateData(
  data: Record<string, string>,
): Record<string, unknown> {
  const mapped = mapOwnerRawData(data);

  if (!mapped.name || !mapped.name.trim()) {
    throw new Error("氏名が空です");
  }

  const createData: Record<string, unknown> = {
    name: mapped.name.trim(),
  };
  if (mapped.nameKana) createData.nameKana = mapped.nameKana.trim();
  if (mapped.phone) createData.phone = mapped.phone.trim();
  if (mapped.zip) createData.zip = mapped.zip.trim();
  if (mapped.address) createData.address = mapped.address.trim();
  // ⚠現住所は住所があるときだけ・郵便番号とペアで入れる（設計 §6.1）。
  if (mapped.currentAddress && mapped.currentAddress.trim()) {
    createData.currentAddress = mapped.currentAddress.trim();
    if (mapped.currentZip && mapped.currentZip.trim()) {
      createData.currentZip = mapped.currentZip.trim();
    }
  }
  if (mapped.note) createData.note = mapped.note.trim();
  if (mapped.externalLinkKey) createData.externalLinkKey = mapped.externalLinkKey.trim();

  return createData;
}

