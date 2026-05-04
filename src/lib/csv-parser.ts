/**
 * Simple CSV parser that handles:
 * - Double-quote escaping
 * - Newlines within quoted fields
 * - BOM removal
 * - Auto-detect comma or tab delimiter
 */

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
  errors: Array<{ row: number; message: string }>;
}

/**
 * 1行目ヘッダーが「実質空」（空文字 / 半角スペース / 全角スペース / 改行 / タブのみ）
 * かどうかを判定する。マッピングUIから候補を除外する用途。
 */
export function isBlankHeader(h: string | null | undefined): boolean {
  if (h == null) return true;
  // 全空白（半角/全角/タブ/改行）を除去して空ならブランク扱い
  return String(h).replace(/[\s　]/g, "") === "";
}

/**
 * ヘッダー配列から実質空のヘッダーを除いた配列を返す。
 * 元配列は変更しない。
 */
export function filterNonBlankHeaders(headers: string[]): string[] {
  return headers.filter((h) => !isBlankHeader(h));
}

export function parseCsv(text: string): CsvParseResult {
  // Remove BOM
  const cleaned = text.replace(/^\uFEFF/, "");

  const lines = splitCsvLines(cleaned);
  if (lines.length === 0) {
    return { headers: [], rows: [], errors: [{ row: 0, message: "空のCSVです" }] };
  }

  // Auto-detect delimiter
  const delimiter = lines[0].includes("\t") ? "\t" : ",";

  const headers = parseCsvLine(lines[0], delimiter).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line, delimiter);
    if (values.length !== headers.length) {
      errors.push({
        row: i + 1,
        message: `カラム数不一致: 期待 ${headers.length}, 実際 ${values.length}`,
      });
      continue;
    }

    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j].trim();
    }
    rows.push(record);
  }

  return { headers, rows, errors };
}

function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

/**
 * CSV column name → Property field name mapping.
 * Supports both Japanese and English column names.
 */
export const PROPERTY_CSV_COLUMN_MAP: Record<string, string> = {
  // Japanese
  "住所": "address",
  "地番": "lotNumber",
  "家屋番号": "buildingNumber",
  "不動産番号": "realEstateNumber",
  "種別": "propertyType",
  "登記状況": "registryStatus",
  "DM判断": "dmStatus",
  "案件ステータス": "caseStatus",
  "用途地域": "zoningDistrict",
  "路線価": "rosenkaValue",
  "緯度": "gpsLat",
  "経度": "gpsLng",
  "備考": "note",
  "リンクキー": "externalLinkKey",
  "外部キー": "externalLinkKey",
  // English
  "address": "address",
  "lotNumber": "lotNumber",
  "lot_number": "lotNumber",
  "buildingNumber": "buildingNumber",
  "building_number": "buildingNumber",
  "realEstateNumber": "realEstateNumber",
  "real_estate_number": "realEstateNumber",
  "propertyType": "propertyType",
  "property_type": "propertyType",
  "registryStatus": "registryStatus",
  "registry_status": "registryStatus",
  "dmStatus": "dmStatus",
  "dm_status": "dmStatus",
  "caseStatus": "caseStatus",
  "case_status": "caseStatus",
  "zoningDistrict": "zoningDistrict",
  "zoning_district": "zoningDistrict",
  "rosenkaValue": "rosenkaValue",
  "rosinka_value": "rosenkaValue",
  "gpsLat": "gpsLat",
  "gps_lat": "gpsLat",
  "gpsLng": "gpsLng",
  "gps_lng": "gpsLng",
  "note": "note",
  "externalLinkKey": "externalLinkKey",
  "external_link_key": "externalLinkKey",
  "link_key": "externalLinkKey",
  // Unit-specific fields (区分マンション)
  "棟名": "buildingName",
  "マンション名": "buildingName",
  "部屋番号": "roomNo",
  "号室": "roomNo",
  "階": "floorNo",
  "階数": "floorNo",
  "専有面積": "exclusiveArea",
  "バルコニー面積": "balconyArea",
  "間取り": "layoutType",
  "向き": "orientation",
  "管理費": "managementFee",
  "修繕積立金": "repairReserveFee",
  "入居状況": "occupancyStatus",
  "持分備考": "ownershipShareNote",
  "buildingName": "buildingName",
  "building_name": "buildingName",
  "roomNo": "roomNo",
  "room_no": "roomNo",
  "floorNo": "floorNo",
  "floor_no": "floorNo",
  "exclusiveArea": "exclusiveArea",
  "exclusive_area": "exclusiveArea",
  "balconyArea": "balconyArea",
  "balcony_area": "balconyArea",
  "layoutType": "layoutType",
  "layout_type": "layoutType",
  "orientation": "orientation",
  "managementFee": "managementFee",
  "management_fee": "managementFee",
  "repairReserveFee": "repairReserveFee",
  "repair_reserve_fee": "repairReserveFee",
  "occupancyStatus": "occupancyStatus",
  "occupancy_status": "occupancyStatus",
  "ownershipShareNote": "ownershipShareNote",
  "ownership_share_note": "ownershipShareNote",
};

/**
 * CSV column name → Owner field name mapping.
 * Supports both Japanese and English column names.
 */
export const OWNER_CSV_COLUMN_MAP: Record<string, string> = {
  // Japanese
  "氏名": "name",
  "名前": "name",
  "氏名カナ": "nameKana",
  "フリガナ": "nameKana",
  "電話番号": "phone",
  "電話": "phone",
  "郵便番号": "zip",
  "住所": "address",
  "所在地": "address",
  "備考": "note",
  "メモ": "note",
  "リンクキー": "externalLinkKey",
  "外部キー": "externalLinkKey",
  // English
  "name": "name",
  "nameKana": "nameKana",
  "name_kana": "nameKana",
  "phone": "phone",
  "zip": "zip",
  "address": "address",
  "note": "note",
  "externalLinkKey": "externalLinkKey",
  "external_link_key": "externalLinkKey",
  "link_key": "externalLinkKey",
};

/**
 * Detect potential duplicates by address or realEstateNumber.
 */
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedField?: string;
  matchedPropertyId?: string;
}
