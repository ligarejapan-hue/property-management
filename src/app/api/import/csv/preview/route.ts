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
import { parseCsv, PROPERTY_CSV_COLUMN_MAP } from "@/lib/csv-parser";

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
    const { csvText, columnMapping } = body as {
      csvText?: string;
      columnMapping?: Record<string, string>;
    };

    if (!csvText) {
      throw new ApiError(422, "csvText は必須です", "VALIDATION_ERROR");
    }

    const { headers, rows } = parseCsv(csvText);

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
    let validRows = 0;
    let errorRows = 0;

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

      // Check duplicates
      const orConditions: Record<string, unknown>[] = [
        { address: mapped.address },
      ];
      if (mapped.realEstateNumber) {
        orConditions.push({ realEstateNumber: mapped.realEstateNumber });
      }
      if (mapped.externalLinkKey) {
        orConditions.push({ externalLinkKey: mapped.externalLinkKey });
      }

      const existing = await prisma.property.findFirst({
        where: { OR: orConditions },
        select: { id: true, address: true, realEstateNumber: true, externalLinkKey: true },
      });

      if (existing) {
        let reason = "住所一致";
        if (mapped.realEstateNumber && existing.realEstateNumber === mapped.realEstateNumber) {
          reason = "不動産番号一致";
        }
        if (mapped.externalLinkKey && existing.externalLinkKey === mapped.externalLinkKey) {
          reason = "リンクキー一致";
        }
        duplicates.push({
          rowNumber: i + 2,
          address: mapped.address,
          matchedPropertyId: existing.id,
          matchedAddress: existing.address,
          matchReason: reason,
        });
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
    });
  } catch (error) {
    return handleApiError(error);
  }
}
