import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  getInvestigation,
  patchInvestigation,
} from "@/lib/investigation/fetch-investigation";

// ---------- GET /api/properties/[id]/investigation ----------
// Returns PropertyInvestigation record (null if not yet created)

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const investigation = await getInvestigation(id);
    return apiResponse({ investigation });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/properties/[id]/investigation ----------
// Partial update of investigation fields

const patchSchema = z.object({
  // 既存フィールド
  zoningDistrict: z.string().optional().nullable(),
  buildingCoverageRatio: z.number().optional().nullable(),
  floorAreaRatio: z.number().optional().nullable(),
  hazardSummary: z.string().optional().nullable(),
  roadSummary: z.string().optional().nullable(),
  infrastructureSummary: z.string().optional().nullable(),
  sourceSummary: z.string().optional().nullable(),
  normalizedAddress: z.string().optional().nullable(),
  landLotNumber: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  // 新規フィールド
  postalCode: z.string().optional().nullable(),
  municipalityCode: z.string().optional().nullable(),
  geocodePrecision: z.string().optional().nullable(),
  firePreventionArea: z.string().optional().nullable(),
  heightDistrict: z.string().optional().nullable(),
  floodRiskLevel: z.string().optional().nullable(),
  stormSurgeRiskLevel: z.string().optional().nullable(),
  tsunamiRiskLevel: z.string().optional().nullable(),
  sedimentRiskCategory: z.string().optional().nullable(),
  nearbyPriceSummary: z.string().optional().nullable(),
  landPriceSummary: z.string().optional().nullable(),
  facilitySummary: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? "入力エラー", "VALIDATION_ERROR");
    }

    const { note, ...fields } = parsed.data;
    const investigation = await patchInvestigation(id, session.id, fields, note ?? undefined);
    return apiResponse({ investigation });
  } catch (error) {
    return handleApiError(error);
  }
}
