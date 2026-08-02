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
import { assertImportJobVisible } from "@/lib/import-job-guard";
import { writeAuditLog } from "@/lib/audit";
import { normalizeCaseStatusInput, normalizeIntroductionRouteInput } from "@/lib/property-types";
import { findDuplicateOwner } from "@/lib/owner-dedup";
import { recalculateJobCounts } from "@/lib/import-job-counts";
import { getStorage } from "@/lib/storage";

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
const JAPANESE_OWNER_FIELD_MAP: Record<string, string> = {
  "氏名": "name",
  "氏名カナ": "nameKana",
  "電話番号": "phone",
  "郵便番号": "zip",
  "住所": "address",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

/**
 * Resolve a rawData key to a property model field name.
 * Tries direct match first (already an English field name), then Japanese lookup.
 */
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

/**
 * Resolve a rawData key to an owner model field name.
 */
function resolveOwnerField(key: string): string | undefined {
  const directFields = new Set([
    "name", "nameKana", "phone", "zip", "address", "note", "externalLinkKey",
  ]);
  if (directFields.has(key)) return key;
  return JAPANESE_OWNER_FIELD_MAP[key];
}

/**
 * Build property create data from a raw data record.
 */
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

/**
 * Build owner create data from a raw data record.
 */
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

// ---------- PATCH /api/import/jobs/:jobId/rows/:rowId ----------

export async function PATCH(
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
    const { action, targetId, editedData } = body as {
      action: "create_new" | "link_existing" | "skip" | "mark_error";
      targetId?: string;
      editedData?: Record<string, string>;
    };

    if (!action) {
      throw new ApiError(422, "action は必須です", "VALIDATION_ERROR");
    }

    // Fetch the row and verify it belongs to this job
    const row = await prisma.importJobRow.findUnique({
      where: { id: rowId },
      include: { job: true },
    });

    if (!row || row.jobId !== jobId) {
      throw new ApiError(404, "行が見つかりません", "NOT_FOUND");
    }

    // 他の担当者が実行した取込は見せない(2026-08-02 監査)。
    assertImportJobVisible(row.job, session.id, perms);

    if (row.status !== "needs_review" && row.status !== "error") {
      throw new ApiError(
        422,
        "この行は解決対象ではありません（ステータス: " + row.status + "）",
        "VALIDATION_ERROR",
      );
    }

    let updatedRow;

    if (action === "create_new") {
      const sourceData = editedData ?? (row.rawData as Record<string, string>);

      let createdRecord: { id: string };

      if (row.job.jobType === "property_csv") {
        const createData = buildPropertyCreateData(sourceData, session.id);
        createdRecord = await prisma.property.create({
          data: createData as Parameters<typeof prisma.property.create>[0]["data"],
        });
      } else if (row.job.jobType === "owner_csv") {
        const createData = buildOwnerCreateData(sourceData);
        const dup = await findDuplicateOwner({
          name: createData.name as string,
          address: createData.address as string | undefined,
          phone: createData.phone as string | undefined,
        });
        if (dup) {
          // PII（name/address/phone/rawData）はレスポンスに含めない。existingOwnerId のみ返す。
          return apiResponse(
            {
              error: {
                message: "既存所有者候補が存在します",
                code: "DUPLICATE_OWNER",
                existingOwnerId: dup.id,
              },
            },
            409,
          );
        }
        createdRecord = await prisma.owner.create({
          data: createData as Parameters<typeof prisma.owner.create>[0]["data"],
        });
      } else {
        throw new ApiError(
          422,
          "このジョブタイプは create_new に対応していません",
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
    } else if (action === "link_existing") {
      if (!targetId) {
        throw new ApiError(422, "targetId は必須です", "VALIDATION_ERROR");
      }

      // Verify the target exists
      if (row.job.jobType === "property_csv") {
        const property = await prisma.property.findUnique({
          where: { id: targetId },
          select: { id: true },
        });
        if (!property) {
          throw new ApiError(404, "指定された物件が見つかりません", "NOT_FOUND");
        }
      } else if (row.job.jobType === "owner_csv") {
        const owner = await prisma.owner.findUnique({
          where: { id: targetId },
          select: { id: true },
        });
        if (!owner) {
          throw new ApiError(404, "指定された所有者が見つかりません", "NOT_FOUND");
        }
      } else if (row.job.jobType === "registry_pdf_bulk") {
        throw new ApiError(
          422,
          "このジョブの行は専用の手動添付APIを使用してください",
          "VALIDATION_ERROR",
        );
      }

      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "success",
          createdId: targetId,
          errorMessage: null,
        },
      });
    } else if (action === "skip") {
      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "skipped",
          errorMessage: "手動スキップ",
        },
      });
    } else if (action === "mark_error") {
      updatedRow = await prisma.importJobRow.update({
        where: { id: rowId },
        data: {
          status: "error",
          errorMessage: "手動エラー確定",
        },
      });
    } else {
      throw new ApiError(422, "無効な action です", "VALIDATION_ERROR");
    }

    // registry_pdf_bulk 行が skip/mark_error で確定した場合、staging(所有者PII)を
    // best-effortで削除する。この種の行はneeds_review/errorのまま放置されず
    // 手動添付対象からも外れる袋小路のため、保管しておく理由が無い。
    if (
      row.job.jobType === "registry_pdf_bulk" &&
      (action === "skip" || action === "mark_error")
    ) {
      const raw = (row.rawData ?? {}) as Record<string, unknown>;
      const stagedKey = typeof raw.stagedKey === "string" ? raw.stagedKey : "";
      if (stagedKey) {
        try {
          await getStorage().delete(stagedKey);
        } catch (e) {
          console.error("import row resolve: staging delete failed:", e);
        }
      }
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
        action,
        rowNumber: row.rowNumber,
        jobId,
      },
    });

    return apiResponse(updatedRow);
  } catch (error) {
    return handleApiError(error);
  }
}
