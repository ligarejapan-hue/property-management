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
import { writeAuditLog } from "@/lib/audit";
import { normalizeCaseStatusInput, normalizeIntroductionRouteInput } from "@/lib/property-types";

/** Map Japanese CSV header names to property model field names. */
const JAPANESE_FIELD_MAP: Record<string, string> = {
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
  "用途地域": "zoningDistrict",
  "路線価": "rosenkaValue",
  "緯度": "gpsLat",
  "経度": "gpsLng",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

/** Map Japanese CSV header names to owner model field names. */
const JAPANESE_OWNER_FIELD_MAP: Record<string, string> = {
  "氏名": "name",
  "氏名カナ": "nameKana",
  "電話番号": "phone",
  "郵便番号": "zip",
  "住所": "address",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

function resolvePropertyField(key: string): string | undefined {
  const directFields = new Set([
    "address", "lotNumber", "buildingNumber", "realEstateNumber",
    "propertyType", "registryStatus", "dmStatus", "caseStatus",
    "introductionRoute", "zoningDistrict", "rosenkaValue", "gpsLat", "gpsLng",
    "note", "externalLinkKey",
  ]);
  if (directFields.has(key)) return key;
  return JAPANESE_FIELD_MAP[key];
}

function resolveOwnerField(key: string): string | undefined {
  const directFields = new Set([
    "name", "nameKana", "phone", "zip", "address", "note", "externalLinkKey",
  ]);
  if (directFields.has(key)) return key;
  return JAPANESE_OWNER_FIELD_MAP[key];
}

function buildPropertyCreateData(
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

function buildOwnerCreateData(
  data: Record<string, string>,
): Record<string, unknown> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = resolveOwnerField(key);
    if (field && value) {
      mapped[field] = value;
    }
  }

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
  if (mapped.note) createData.note = mapped.note.trim();
  if (mapped.externalLinkKey) createData.externalLinkKey = mapped.externalLinkKey.trim();

  return createData;
}

async function recalculateJobCounts(jobId: string): Promise<void> {
  const rows = await prisma.importJobRow.findMany({
    where: { jobId },
    select: { status: true },
  });

  const successCount = rows.filter((r) => r.status === "success").length;
  const errorCount = rows.filter((r) => r.status === "error").length;
  const needsReviewCount = rows.filter((r) => r.status === "needs_review").length;

  const hasUnresolved = errorCount > 0 || needsReviewCount > 0;

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      successCount,
      errorCount: errorCount + needsReviewCount,
      ...(hasUnresolved ? {} : { status: "completed", completedAt: new Date() }),
    },
  });
}

// ---------- POST /api/import/jobs/:jobId/rows/:rowId/retry ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; rowId: string }> },
) {
  try {
    const { jobId, rowId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { editedData } = body as {
      editedData?: Record<string, string>;
    };

    // Fetch the row and verify it belongs to this job
    const row = await prisma.importJobRow.findUnique({
      where: { id: rowId },
      include: { job: true },
    });

    if (!row || row.jobId !== jobId) {
      throw new ApiError(404, "行が見つかりません", "NOT_FOUND");
    }

    if (row.status !== "error") {
      throw new ApiError(
        422,
        "リトライはエラー行のみ可能です（ステータス: " + row.status + "）",
        "VALIDATION_ERROR",
      );
    }

    // Merge editedData over rawData if provided
    const mergedData: Record<string, string> = {
      ...(row.rawData as Record<string, string>),
      ...(editedData ?? {}),
    };

    let updatedRow;

    try {
      let createdRecord: { id: string };

      if (row.job.jobType === "property_csv") {
        const createData = buildPropertyCreateData(mergedData, session.id);
        createdRecord = await prisma.property.create({
          data: createData as Parameters<typeof prisma.property.create>[0]["data"],
        });
      } else if (row.job.jobType === "owner_csv") {
        const createData = buildOwnerCreateData(mergedData);
        createdRecord = await prisma.owner.create({
          data: createData as Parameters<typeof prisma.owner.create>[0]["data"],
        });
      } else {
        throw new ApiError(
          422,
          "このジョブタイプはリトライに対応していません",
          "VALIDATION_ERROR",
        );
      }

      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "success",
          createdId: createdRecord.id,
          errorMessage: null,
        },
      });
    } catch (err) {
      // If it's an ApiError, re-throw it
      if (err instanceof ApiError) throw err;

      // Otherwise, it's a creation failure - update the error message
      const newErrorMessage = err instanceof Error ? err.message : "不明なエラー";
      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          errorMessage: newErrorMessage,
        },
      });
    }

    // Recalculate job counts
    await recalculateJobCounts(jobId);

    // Write audit log
    await writeAuditLog({
      userId: session.id,
      action: "import_row_resolve",
      targetTable: "import_job_rows",
      targetId: rowId,
      detail: {
        action: "retry",
        rowNumber: row.rowNumber,
        jobId,
      },
    });

    return apiResponse(updatedRow);
  } catch (error) {
    return handleApiError(error);
  }
}
