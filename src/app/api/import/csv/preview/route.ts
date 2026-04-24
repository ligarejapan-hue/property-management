import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { PROPERTY_CSV_COLUMN_MAP } from "@/lib/csv-parser";
import {
  buildDedupeIndex,
  findPropertyDuplicate,
  isUpdateEligibleReason,
} from "@/lib/import-dedupe";
import { detectImportFileType } from "@/lib/import-file-type";
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";

const JAPANESE_FIELD_MAP: Record<string, string> = {
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
};

// ---------- POST /api/import/csv/preview ----------
// Preview duplicate candidates before actual import

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { csvText, xlsxBase64, columnMapping, fileName } = body as {
      csvText?: string;
      xlsxBase64?: string;
      columnMapping?: Record<string, string>;
      fileName?: string;
    };

    if (!fileName) {
      throw new ApiError(422, "fileName は必須です", "VALIDATION_ERROR");
    }
    if (!csvText && !xlsxBase64) {
      throw new ApiError(422, "csvText または xlsxBase64 は必須です", "VALIDATION_ERROR");
    }

    const fileTypeDetection = detectImportFileType(fileName);

    let headers: string[];
    let rows: Record<string, string>[];
    try {
      const parsed = parseSheet({ fileName, csvText, xlsxBase64 });
      headers = parsed.headers;
      rows = parsed.rows;
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }

    // Build header → field mapping
    const headerToField: Record<string, string> = {};
    if (columnMapping && Object.keys(columnMapping).length > 0) {
      for (const [csvHeader, japaneseName] of Object.entries(columnMapping)) {
        const field = JAPANESE_FIELD_MAP[japaneseName];
        if (field) headerToField[csvHeader] = field;
      }
    } else {
      for (const h of headers) {
        if (PROPERTY_CSV_COLUMN_MAP[h]) {
          headerToField[h] = PROPERTY_CSV_COLUMN_MAP[h];
        }
      }
    }

    const duplicates: Array<{
      rowNumber: number;
      address: string;
      matchedPropertyId: string;
      matchedAddress: string;
      matchReason: string;
    }> = [];
    const updates: Array<{
      rowNumber: number;
      address: string;
      matchedPropertyId: string;
      matchedAddress: string;
      matchReason: string;
    }> = [];
    let validRows = 0;
    let errorRows = 0;

    // Build normalized dedupe index once across existing properties
    const existingProps = await prisma.property.findMany({
      select: {
        id: true,
        address: true,
        roomNo: true,
        buildingId: true,
        realEstateNumber: true,
        externalLinkKey: true,
      },
    });
    const dedupeIndex = buildDedupeIndex(existingProps);

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const mapped: Record<string, string> = {};
      for (const [csvCol, value] of Object.entries(rawRow)) {
        const field = headerToField[csvCol];
        if (field) mapped[field] = value;
      }

      if (!mapped.address) {
        errorRows++;
        continue;
      }

      const hit = findPropertyDuplicate(
        dedupeIndex,
        {
          address: mapped.address,
          realEstateNumber: mapped.realEstateNumber,
          externalLinkKey: mapped.externalLinkKey,
        },
        existingProps,
      );

      if (hit) {
        const entry = {
          rowNumber: i + 2,
          address: mapped.address,
          matchedPropertyId: hit.matchedId,
          matchedAddress: hit.matchedAddress,
          matchReason: hit.reason,
        };
        if (isUpdateEligibleReason(hit.reason)) {
          updates.push(entry);
        } else {
          duplicates.push(entry);
        }
      } else {
        validRows++;
      }
    }

    return apiResponse({
      totalRows: rows.length,
      validRows,
      errorRows,
      duplicateCount: duplicates.length,
      duplicates: duplicates.slice(0, 20), // Show max 20
      updateCount: updates.length,
      updates: updates.slice(0, 20),
      fileType: fileTypeDetection.type,
      fileTypeLabel: fileTypeDetection.label,
      fileTypeError: fileTypeDetection.error,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
