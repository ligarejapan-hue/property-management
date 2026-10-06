/**
 * 取込エラー行の「編集して作成」と「再試行」が共有する、rawData → モデル項目の対応表。
 *
 * ⚠この2つの route は元は**完全なコピペ重複**だった。列が増えるたびに片方だけ直す
 *   事故（片方の画面からだけ値が入らない）を防ぐため、正本をここ1か所にする。
 */
import {
  normalizeCaseStatusInput,
  normalizeIntroductionRouteInput,
  PROPERTY_TYPE_JP_TO_VALUE,
  PROPERTY_TYPE_VALUES,
} from "@/lib/property-types";
import { phoneForStore } from "@/lib/phone-format-jp";
import { AUTO_CHOICE, type BuildingChoice } from "@/lib/building-link/resolve";
import { normalizeBuildingName } from "@/lib/property-building-name";
import { OWNER_CSV_COLUMN_MAP, PROPERTY_CSV_COLUMN_MAP } from "@/lib/csv-parser";
import { isValidPostalCode, normalizePostalCode } from "@/lib/address-lookup/normalize";
import { unwrapCsvTextCell } from "@/lib/csv-encode";

// CSV 取込(api/import/csv)と同じ決まった値。外れた値は落とす(CSV 取込と同じ)。
const VALID_REGISTRY_STATUS = ["unconfirmed", "scheduled", "obtained"];
const VALID_DM_STATUS = ["send", "hold", "no_send"];
const VALID_OCCUPANCY_STATUS = ["vacant", "occupied", "unknown"];
// 棟郵便番号は棟の欄。確定は物件を作るだけなので読まない。
const NOT_PROPERTY_FIELDS = new Set(["buildingPostalCode"]);

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
  // 区分マンションの物件名(CSV 取込 api/import/csv の JAPANESE_FIELD_MAP と同じ2列だけ)。
  // ⚠「物件名」は足さない: 不動産業者形式のひな形の汎用列で戸建・土地も入る。物件名があると
  //   区分マンションとして作る規則なので、戸建が黙って区分になり棟まで作られてしまう。
  "棟名": "buildingName",
  "マンション名": "buildingName",
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
 *
 * ⚠rawData は CSV の見出しのまま保存されている。CSV 取込が読む見出し(PROPERTY_CSV_COLUMN_MAP)を
 *   ここでも読む(以前は部屋番号・階・専有面積・郵便番号・`lot_number` などが確定で落ちていた)。
 */
/** 確定で物件に入れられる欄。 */
const PROPERTY_ROW_FIELDS: ReadonlySet<string> = new Set([
  "address", "postalCode", "lotNumber", "buildingNumber", "realEstateNumber",
  "propertyType", "registryStatus", "dmStatus", "caseStatus",
  "introductionRoute", "zoningDistrict", "rosenkaValue", "gpsLat", "gpsLng",
  "note", "externalLinkKey", "buildingName",
  "roomNo", "floorNo", "exclusiveArea", "balconyArea", "layoutType", "orientation",
  "managementFee", "repairReserveFee", "occupancyStatus", "ownershipShareNote",
]);

/** 確定で所有者に入れられる欄。 */
const OWNER_ROW_FIELDS: ReadonlySet<string> = new Set([
  "name", "nameKana", "phone", "zip", "address",
  "currentZip", "currentAddress",
  "note", "externalLinkKey",
]);

export function resolvePropertyField(key: string): string | undefined {
  if (PROPERTY_ROW_FIELDS.has(key)) return key;
  const fromCsv = PROPERTY_CSV_COLUMN_MAP[key];
  if (fromCsv && !NOT_PROPERTY_FIELDS.has(fromCsv)) return fromCsv;
  return JAPANESE_FIELD_MAP[key];
}

/**
 * Resolve a rawData key to an owner model field name.
 * ⚠所有者 CSV 取込が読む見出し(OWNER_CSV_COLUMN_MAP)もここで読む(物件と同じ理由)。
 */
export function resolveOwnerField(key: string): string | undefined {
  if (OWNER_ROW_FIELDS.has(key)) return key;
  const fromCsv = OWNER_CSV_COLUMN_MAP[key];
  if (fromCsv && OWNER_ROW_FIELDS.has(fromCsv)) return fromCsv;
  return JAPANESE_OWNER_FIELD_MAP[key];
}

/**
 * 取込のときに実際に使った「CSV の見出し → 欄」の表を、要確認・エラーの行に一緒に残すキー。
 * ⚠画面で列の対応を指定した取込(例: 所在地 → 住所)は、見出しだけでは確定で読み替えられない。
 *   `__` で始まるので画面・エラー行の書き出しには出ない。
 */
export const ROW_FIELD_MAP_KEY = "__field_map";

/** 行に足す `{ __field_map: "<JSON>" }`。表が空なら何も足さない。 */
export function rowFieldMapExtra(headerToField: Record<string, string>): Record<string, string> {
  return Object.keys(headerToField).length > 0
    ? { [ROW_FIELD_MAP_KEY]: JSON.stringify(headerToField) }
    : {};
}

/** 行に残った表を読む。壊れている・無いときは null(=決まった表で読み替える。以前の行)。 */
function readRowFieldMap(
  data: Record<string, string>,
  allowed: ReadonlySet<string>,
): Record<string, string> | null {
  const raw = data[ROW_FIELD_MAP_KEY];
  if (typeof raw !== "string" || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const map: Record<string, string> = {};
  for (const [header, field] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof field === "string" && allowed.has(field)) map[header] = field;
  }
  return map;
}

/**
 * rawData を欄の名前へ読み替える（空値は落とす）。
 * 取込で使った表が行に残っていれば、**その表だけ**で読む(取込と同じ結果にする)。
 */
function mapRawData(
  data: Record<string, string>,
  allowed: ReadonlySet<string>,
  resolve: (key: string) => string | undefined,
): Record<string, string> {
  const rowMap = readRowFieldMap(data, allowed);
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("__")) continue;
    const field = rowMap ? rowMap[key] : resolve(key);
    if (field && value) {
      mapped[field] = value;
    }
  }
  return mapped;
}

/**
 * rawData を所有者の項目名へ読み替える（空値は落とす）。
 * 作成にも「既存所有者の空欄補完」にも同じ読み替えを使うために切り出してある。
 */
export function mapOwnerRawData(
  data: Record<string, string>,
): Record<string, string> {
  return mapRawData(data, OWNER_ROW_FIELDS, resolveOwnerField);
}

/**
 * Build property create data from a raw data record.
 */
export function buildPropertyCreateData(
  data: Record<string, string>,
  createdBy: string,
): Record<string, unknown> {
  const mapped = mapRawData(data, PROPERTY_ROW_FIELDS, resolvePropertyField);

  if (!mapped.address) {
    throw new Error("住所が空です");
  }

  // 種別の日本語は値に直し、知らない値は不明にする。登記状況・DM判断の外れた値は既定値にする
  // (CSV 取込と同じ。以前は「土地」のまま作ろうとして確定が失敗していた)。
  let propertyType = mapped.propertyType || "unknown";
  if (PROPERTY_TYPE_JP_TO_VALUE[propertyType]) {
    propertyType = PROPERTY_TYPE_JP_TO_VALUE[propertyType];
  } else if (!(PROPERTY_TYPE_VALUES as readonly string[]).includes(propertyType)) {
    propertyType = "unknown";
  }
  const createData: Record<string, unknown> = {
    address: mapped.address,
    propertyType,
    registryStatus: VALID_REGISTRY_STATUS.includes(mapped.registryStatus) ? mapped.registryStatus : "unconfirmed",
    dmStatus: VALID_DM_STATUS.includes(mapped.dmStatus) ? mapped.dmStatus : "hold",
    caseStatus: normalizeCaseStatusInput(mapped.caseStatus) ?? "new_case",
    createdBy,
  };
  if (mapped.postalCode && isValidPostalCode(mapped.postalCode)) {
    createData.postalCode = normalizePostalCode(mapped.postalCode);
  }
  const normalizedRoute = normalizeIntroductionRouteInput(mapped.introductionRoute);
  if (normalizedRoute) createData.introductionRoute = normalizedRoute;
  // 本システムが書き出した CSV は Excel 対策で `="4-2"` の形。CSV 取込と同じく元の値に戻す。
  const lotNumber = mapped.lotNumber ? unwrapCsvTextCell(mapped.lotNumber) : "";
  const buildingNumber = mapped.buildingNumber ? unwrapCsvTextCell(mapped.buildingNumber) : "";
  if (lotNumber) createData.lotNumber = lotNumber;
  if (buildingNumber) createData.buildingNumber = buildingNumber;
  // ⚠CSV 取込と同じ規則: 物件名がある行は区分マンションとして作る
  //   (以前は物件名を読まず、要確認から確定すると物件名も棟も落ちていた)。
  //   物件名の整え方も CSV 取込と同じ normalizeBuildingName を通す。
  const buildingNameForCreate = normalizeBuildingName("apartment_unit", mapped.buildingName);
  if (buildingNameForCreate) {
    createData.propertyType = "apartment_unit";
    createData.buildingName = buildingNameForCreate;
  }
  if (mapped.realEstateNumber) createData.realEstateNumber = mapped.realEstateNumber;
  // ⚠リンクキーは trim だけ(正規化しない・CSV 取込と同じ)。
  const linkKey = mapped.externalLinkKey?.trim();
  if (linkKey) createData.externalLinkKey = linkKey;
  if (mapped.zoningDistrict) createData.zoningDistrict = mapped.zoningDistrict;
  if (mapped.rosenkaValue) createData.rosenkaValue = parseFloat(mapped.rosenkaValue) || null;
  if (mapped.gpsLat) createData.gpsLat = parseFloat(mapped.gpsLat) || null;
  if (mapped.gpsLng) createData.gpsLng = parseFloat(mapped.gpsLng) || null;
  if (mapped.note) createData.note = mapped.note;

  // 部屋の欄(CSV 取込と同じ読み方。数字にできない値は入れない)。
  if (mapped.roomNo) createData.roomNo = mapped.roomNo.trim();
  const intOf = (v: string | undefined) => (v ? parseInt(v) : NaN);
  const floatOf = (v: string | undefined) => (v ? parseFloat(v) : NaN);
  if (!isNaN(intOf(mapped.floorNo))) createData.floorNo = intOf(mapped.floorNo);
  if (!isNaN(floatOf(mapped.exclusiveArea))) createData.exclusiveArea = floatOf(mapped.exclusiveArea);
  if (!isNaN(floatOf(mapped.balconyArea))) createData.balconyArea = floatOf(mapped.balconyArea);
  if (mapped.layoutType) createData.layoutType = mapped.layoutType.trim();
  if (mapped.orientation) createData.orientation = mapped.orientation.trim();
  if (!isNaN(intOf(mapped.managementFee))) createData.managementFee = intOf(mapped.managementFee);
  if (!isNaN(intOf(mapped.repairReserveFee))) createData.repairReserveFee = intOf(mapped.repairReserveFee);
  if (mapped.occupancyStatus && VALID_OCCUPANCY_STATUS.includes(mapped.occupancyStatus)) {
    createData.occupancyStatus = mapped.occupancyStatus;
  }
  if (mapped.ownershipShareNote) createData.ownershipShareNote = mapped.ownershipShareNote;

  return createData;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 要確認の画面で選んだ棟(`__resolved_building_id`)を、確定時の棟の選び方にする。 */
export function buildingChoiceFromRow(data: Record<string, string>): BuildingChoice {
  const id = String(data["__resolved_building_id"] ?? "").trim();
  return UUID_RE.test(id) ? { kind: "existing", buildingId: id.toLowerCase() } : AUTO_CHOICE;
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
  // 画面と同じ規則でそろえる(数字だけならハイフンを入れる・手の区切りは残す)。
  if (mapped.phone) createData.phone = phoneForStore(mapped.phone);
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

