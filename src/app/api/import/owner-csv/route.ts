import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { parseCsv, OWNER_CSV_COLUMN_MAP } from "@/lib/csv-parser";

// Japanese field name → Owner model property mapping
const JAPANESE_FIELD_TO_PROPERTY: Record<string, string> = {
  "氏名": "name",
  "氏名カナ": "nameKana",
  "電話番号": "phone",
  "郵便番号": "zip",
  "住所": "address",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

// ---------- POST /api/import/owner-csv ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "CSV取込の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { fileName, csvText, columnMapping: userColumnMapping } = body as {
      fileName?: string;
      csvText?: string;
      columnMapping?: Record<string, string>;
    };

    if (!csvText || typeof csvText !== "string") {
      throw new ApiError(422, "csvText は必須です", "VALIDATION_ERROR");
    }

    // Parse CSV
    const { headers, rows, errors: parseErrors } = parseCsv(csvText);

    if (rows.length === 0 && parseErrors.length > 0) {
      throw new ApiError(422, "CSVのパースに失敗しました", "VALIDATION_ERROR");
    }

    // Build effective column mapping: CSV header → Owner model property
    // If userColumnMapping is provided, it maps CSV header → Japanese field name
    // Then we resolve Japanese field name → model property
    // Otherwise, auto-map via OWNER_CSV_COLUMN_MAP
    const effectiveMapping: Record<string, string> = {};

    if (userColumnMapping && Object.keys(userColumnMapping).length > 0) {
      for (const [csvHeader, japaneseField] of Object.entries(userColumnMapping)) {
        const modelProp = JAPANESE_FIELD_TO_PROPERTY[japaneseField];
        if (modelProp) {
          effectiveMapping[csvHeader] = modelProp;
        }
      }
    } else {
      for (const h of headers) {
        if (OWNER_CSV_COLUMN_MAP[h]) {
          effectiveMapping[h] = OWNER_CSV_COLUMN_MAP[h];
        }
      }
    }

    // Create import job
    const job = await prisma.importJob.create({
      data: {
        jobType: "owner_csv",
        fileName: fileName ?? "owner-import.csv",
        status: "processing",
        totalRows: rows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let errorCount = 0;
    let needsReviewCount = 0;
    const createdOwnerIds: string[] = [];

    const jobRows: Array<{
      jobId: string;
      rowNumber: number;
      status: "success" | "error" | "needs_review";
      rawData: Record<string, string>;
      errorMessage: string | null;
      createdId: string | null;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const rowNumber = i + 2; // 1-indexed, header is row 1

      try {
        // Map CSV columns to owner fields
        const mapped: Record<string, string> = {};
        for (const [csvCol, value] of Object.entries(rawRow)) {
          const field = effectiveMapping[csvCol];
          if (field) {
            mapped[field] = value;
          }
        }

        // Validate: name is required
        if (!mapped.name || !mapped.name.trim()) {
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData: rawRow,
            errorMessage: "氏名が空です",
            createdId: null,
          });
          errorCount++;
          continue;
        }

        // Duplicate check: by name + (phone or address)
        const duplicateConditions: Record<string, unknown>[] = [];
        if (mapped.phone) {
          duplicateConditions.push({ name: mapped.name, phone: mapped.phone });
        }
        if (mapped.address) {
          duplicateConditions.push({ name: mapped.name, address: mapped.address });
        }
        // If neither phone nor address, check by name only
        if (duplicateConditions.length === 0) {
          duplicateConditions.push({ name: mapped.name });
        }

        const existing = await prisma.owner.findFirst({
          where: { OR: duplicateConditions },
          select: { id: true, name: true },
        });

        if (existing) {
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData: rawRow,
            errorMessage: `重複の可能性: 既存所有者ID=${existing.id} (${existing.name})`,
            createdId: null,
          });
          needsReviewCount++;
          continue;
        }

        // Build create data
        const createData: Record<string, unknown> = {
          name: mapped.name.trim(),
        };
        if (mapped.nameKana) createData.nameKana = mapped.nameKana.trim();
        if (mapped.phone) createData.phone = mapped.phone.trim();
        if (mapped.zip) createData.zip = mapped.zip.trim();
        if (mapped.address) createData.address = mapped.address.trim();
        if (mapped.note) createData.note = mapped.note.trim();
        if (mapped.externalLinkKey) createData.externalLinkKey = mapped.externalLinkKey.trim();

        const owner = await prisma.owner.create({
          data: createData as Parameters<typeof prisma.owner.create>[0]["data"],
        });

        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "success",
          rawData: rawRow,
          errorMessage: null,
          createdId: owner.id,
        });
        createdOwnerIds.push(owner.id);
        successCount++;
      } catch (err) {
        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "error",
          rawData: rawRow,
          errorMessage: err instanceof Error ? err.message : "不明なエラー",
          createdId: null,
        });
        errorCount++;
      }
    }

    // Save job rows
    for (const row of jobRows) {
      await prisma.importJobRow.create({
        data: {
          jobId: row.jobId,
          rowNumber: row.rowNumber,
          status: row.status,
          rawData: row.rawData,
          errorMessage: row.errorMessage,
          createdId: row.createdId,
        },
      });
    }

    // Auto-link owners to properties via externalLinkKey
    let linkedCount = 0;

    if (createdOwnerIds.length > 0) {
      const ownersWithLinkKey = await prisma.owner.findMany({
        where: {
          id: { in: createdOwnerIds },
          externalLinkKey: { not: null },
        },
        select: { id: true, externalLinkKey: true },
      });

      for (const owner of ownersWithLinkKey) {
        if (!owner.externalLinkKey) continue;

        const matchingProperties = await prisma.property.findMany({
          where: { externalLinkKey: owner.externalLinkKey },
          select: { id: true },
        });

        for (const property of matchingProperties) {
          // Skip if link already exists
          const existingLink = await prisma.propertyOwner.findUnique({
            where: {
              propertyId_ownerId: {
                propertyId: property.id,
                ownerId: owner.id,
              },
            },
          });

          if (!existingLink) {
            await prisma.propertyOwner.create({
              data: {
                propertyId: property.id,
                ownerId: owner.id,
                relationship: "所有者",
                isPrimary: false,
              },
            });
            linkedCount++;
          }
        }
      }
    }

    // Finalize job
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: errorCount > 0 ? "failed" : "completed",
        successCount,
        errorCount: errorCount + needsReviewCount,
        completedAt: new Date(),
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "owner_csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        fileName: fileName ?? "owner-import.csv",
        totalRows: rows.length,
        successCount,
        errorCount,
        needsReviewCount,
        linkedCount,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        totalRows: rows.length,
        successCount,
        errorCount,
        needsReviewCount,
        linkedCount,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
