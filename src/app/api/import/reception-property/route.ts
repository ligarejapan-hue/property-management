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
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";
import { detectImportFileType } from "@/lib/import-file-type";
import {
  parseReceptionRows,
  applyReceptionFilters,
  DEFAULT_RECEPTION_FILTER_OPTIONS,
  type DlFilterMode,
  type ShinkiFilterMode,
} from "@/lib/reception-owner-match";
import { normalizeAddress } from "@/lib/normalize";

// 受付帳CSVから物件を新規作成する取込実行。
// - フィルタ後のアクティブ行のうち、住所あり・住所未重複の行だけ Property を作成。
// - 住所なし / 既存住所一致 は needs_review。
// - jobType: "property_csv"（既存 enum を流用、migration 不要）。

const F_COLUMN_TO_PROPERTY_TYPE: Record<string, string> = {
  土地: "land",
  建物: "house",
  区分: "apartment_unit",
  区建: "apartment_unit",
};

function fColumnToPropertyType(f: string): string {
  return F_COLUMN_TO_PROPERTY_TYPE[f.trim()] ?? "unknown";
}

function toPositionalRows(
  headers: string[],
  rows: readonly Record<string, string>[],
): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const {
      receptionCsv,
      receptionXlsxBase64,
      receptionFileName,
      dlFilter,
      shinkiFilter,
    } = body as {
      receptionCsv?: string;
      receptionXlsxBase64?: string;
      receptionFileName?: string;
      dlFilter?: DlFilterMode;
      shinkiFilter?: ShinkiFilterMode;
    };
    const filterOptions = {
      dl: dlFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.dl,
      shinki: shinkiFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.shinki,
    };

    if (!receptionFileName) {
      throw new ApiError(422, "receptionFileName は必須です", "VALIDATION_ERROR");
    }
    if (!receptionCsv && !receptionXlsxBase64) {
      throw new ApiError(
        422,
        "csv または xlsx のいずれかを指定してください",
        "VALIDATION_ERROR",
      );
    }

    const receptionDetect = detectImportFileType(receptionFileName);
    if (receptionDetect.type !== "reception") {
      throw new ApiError(
        422,
        `受付帳ファイルとして認識できません: ${receptionDetect.error ?? "ファイル名に『受付帳』を含めてください"}`,
        "VALIDATION_ERROR",
      );
    }

    let receptionParsed: ReturnType<typeof parseSheet>;
    try {
      receptionParsed = parseSheet({
        fileName: receptionFileName,
        csvText: receptionCsv,
        xlsxBase64: receptionXlsxBase64,
      });
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }

    const allRows = applyReceptionFilters(
      parseReceptionRows(
        toPositionalRows(receptionParsed.headers, receptionParsed.rows),
      ),
      filterOptions,
    );

    // 既存物件の正規化住所インデックス
    const existing = await prisma.property.findMany({
      select: { id: true, address: true },
    });
    const existingNorm = new Map<string, string>();
    for (const p of existing) {
      const n = normalizeAddress(p.address);
      if (n && !existingNorm.has(n)) existingNorm.set(n, p.id);
    }

    const activeRows = allRows.filter((r) => !r.excluded);

    const job = await prisma.importJob.create({
      data: {
        jobType: "property_csv",
        fileName: receptionFileName,
        status: "processing",
        totalRows: activeRows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let needsReviewCount = 0;
    let errorCount = 0;

    for (const row of activeRows) {
      const rowNumber = row.rowNumber;
      const rawData: Record<string, string> = {
        fColumn: row.fColumn,
        kColumn: row.kColumn,
        lotNumber: row.lotNumber ?? "",
        buildingNumber: row.buildingNumber ?? "",
        propertyAddress: row.propertyAddress ?? "",
        DL: row.dlMarked ? "〇" : "",
        新既: row.shinkiValue,
      };

      if (!row.propertyAddress) {
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData,
            errorMessage: "住所なし（H/I/J 列が全て空）",
            createdId: null,
          },
        });
        needsReviewCount++;
        continue;
      }

      const norm = normalizeAddress(row.propertyAddress);
      const existingId = norm ? existingNorm.get(norm) : undefined;
      if (existingId) {
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData,
            errorMessage: `住所が既存物件と重複（ID: ${existingId}）`,
            createdId: existingId,
          },
        });
        needsReviewCount++;
        continue;
      }

      try {
        const propertyType = fColumnToPropertyType(row.fColumn) as
          | "land"
          | "house"
          | "apartment_unit"
          | "unknown";

        const property = await prisma.property.create({
          data: {
            propertyType,
            address: row.propertyAddress,
            lotNumber: row.lotNumber ?? undefined,
            buildingNumber: row.buildingNumber ?? undefined,
            registryStatus: "unconfirmed",
            dmStatus: "hold",
            createdBy: session.id,
          },
          select: { id: true },
        });

        // 今回作成した住所を重複判定に反映（同一 CSV 内重複を防止）
        if (norm) existingNorm.set(norm, property.id);

        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "success",
            rawData,
            errorMessage: null,
            createdId: property.id,
          },
        });
        successCount++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "不明なエラー";
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData,
            errorMessage: errMsg,
            createdId: null,
          },
        });
        errorCount++;
      }
    }

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
      action: "reception_property_csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        receptionFileName,
        successCount,
        needsReviewCount,
        errorCount,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        successCount,
        needsReviewCount,
        errorCount,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
