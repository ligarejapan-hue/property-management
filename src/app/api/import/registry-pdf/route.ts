import { NextRequest } from "next/server";
import { z } from "zod";
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
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";

const registryPdfJsonSchema = z.object({
  /** Extracted text from the PDF (テキスト貼り付けモード) */
  text: z.string().min(1, "テキストは必須です"),
  /** Optional: property ID to update instead of creating new */
  propertyId: z.string().uuid().optional().nullable(),
  /** File name for audit purposes */
  fileName: z.string().optional(),
});

// ---------- POST /api/import/registry-pdf ----------
// リクエスト形式:
//   multipart/form-data → file: PDF binary (+ optional propertyId, fileName)
//   application/json    → { text, propertyId?, fileName? }  (後方互換)

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    let propertyId: string | null = null;
    let fileName = "registry.pdf";

    if (contentType.includes("multipart/form-data")) {
      // --- PDF バイナリ受信 ---
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        throw new ApiError(400, "ファイルが指定されていません", "NO_FILE");
      }

      fileName = (file as File).name ?? "registry.pdf";
      const propIdValue = formData.get("propertyId");
      propertyId =
        propIdValue && typeof propIdValue === "string" ? propIdValue : null;

      const arrayBuffer = await (file as File).arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (!isPdfBuffer(buffer)) {
        throw new ApiError(
          400,
          "PDFファイルではありません (magic bytes 不一致)",
          "INVALID_PDF",
        );
      }

      try {
        text = await extractTextFromPdf(buffer);
      } catch (err) {
        throw new ApiError(
          422,
          `PDFテキスト抽出に失敗しました: ${err instanceof Error ? err.message : "不明なエラー"}`,
          "PDF_PARSE_FAILED",
        );
      }
    } else {
      // --- テキスト直接受信 (後方互換) ---
      const body = await request.json();
      const data = registryPdfJsonSchema.parse(body);
      text = data.text;
      propertyId = data.propertyId ?? null;
      fileName = data.fileName ?? "registry.pdf";
    }

    // Parse the registry text
    const parsed = parseRegistryText(text);

    // Create import job record
    const job = await prisma.importJob.create({
      data: {
        jobType: "property_pdf",
        fileName: fileName,
        status: "processing",
        totalRows: 1,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let resultAction: "created" | "updated" | "matched" = "matched";
    let targetPropertyId: string | null = null;
    // 失敗理由（silent fail-through 用と、catch ブロックでの recovery 用）。
    // null のままなら成功扱い。
    let failureReason: string | null = null;

    try {
    if (propertyId) {
      // ---- Mode A: Update existing property ----
      const existing = await prisma.property.findUnique({
        where: { id: propertyId },
      });

      if (!existing) {
        throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
      }

      // Build update fields (only fill empty/null fields, don't overwrite)
      const updates: Record<string, unknown> = {};
      if (!existing.realEstateNumber && parsed.realEstateNumber) {
        updates.realEstateNumber = parsed.realEstateNumber;
      }
      if (!existing.lotNumber && parsed.lotNumber) {
        updates.lotNumber = parsed.lotNumber;
      }
      if (!existing.buildingNumber && parsed.buildingNumber) {
        updates.buildingNumber = parsed.buildingNumber;
      }
      if (
        existing.registryStatus === "unconfirmed" &&
        parsed.realEstateNumber
      ) {
        updates.registryStatus = "obtained";
      }

      if (Object.keys(updates).length > 0) {
        await prisma.property.updateMany({
          where: { id: propertyId, version: existing.version },
          data: { ...updates, version: { increment: 1 } },
        });

        await recordChanges({
          targetTable: "properties",
          targetId: propertyId,
          changedBy: session.id,
          oldValues: existing as unknown as Record<string, unknown>,
          newValues: updates,
          trackedFields: PROPERTY_TRACKED_FIELDS,
          source: "pdf_import",
        });

        resultAction = "updated";
      }

      targetPropertyId = propertyId;

      // Auto-link owners if parsed
      for (const ownerInfo of parsed.owners) {
        if (!ownerInfo.name) continue;

        // Try to find existing owner by name
        let owner = await prisma.owner.findFirst({
          where: { name: ownerInfo.name },
        });

        if (!owner) {
          owner = await prisma.owner.create({
            data: {
              name: ownerInfo.name,
              address: ownerInfo.address,
            },
          });
        }

        // Link to property if not already linked
        const existingLink = await prisma.propertyOwner.findFirst({
          where: {
            propertyId: propertyId,
            ownerId: owner.id,
          },
        });

        if (!existingLink) {
          await prisma.propertyOwner.create({
            data: {
              propertyId: propertyId,
              ownerId: owner.id,
              relationship: ownerInfo.share ? "共有者" : "所有者",
            },
          });
        }
      }
    } else {
      // ---- Mode B: Try to match or create new ----
      let matchedProperty = null;

      if (parsed.realEstateNumber) {
        matchedProperty = await prisma.property.findFirst({
          where: { realEstateNumber: parsed.realEstateNumber },
          select: { id: true, address: true, realEstateNumber: true },
        });
      }

      if (!matchedProperty && parsed.address) {
        matchedProperty = await prisma.property.findFirst({
          where: { address: { contains: parsed.address } },
          select: { id: true, address: true, realEstateNumber: true },
        });
      }

      if (matchedProperty) {
        targetPropertyId = matchedProperty.id;
        resultAction = "matched";
      } else if (parsed.address) {
        // Create new property
        const newProp = await prisma.property.create({
          data: {
            address: parsed.address,
            lotNumber: parsed.lotNumber,
            buildingNumber: parsed.buildingNumber,
            realEstateNumber: parsed.realEstateNumber,
            propertyType: parsed.buildingNumber ? "building" : "land",
            registryStatus: parsed.realEstateNumber
              ? "obtained"
              : "unconfirmed",
            dmStatus: "hold",
            createdBy: session.id,
          },
        });
        targetPropertyId = newProp.id;
        resultAction = "created";
      }
    }

    // Silent fail-through 検出: ジョブは作成済みだが
    //  Mode A/B のどちらでも targetPropertyId が立たなかった = 物件操作なし。
    // これまでは status="completed" / errorCount=1 のまま行を残さず返していたが、
    // status="failed" + ImportJobRow(error) を残し、詳細画面で原因を追えるようにする。
    if (!targetPropertyId) {
      failureReason = !parsed.address
        ? "PDFから住所を抽出できませんでした。OCRに失敗したか、想定外のフォーマットの可能性があります。"
        : "PDFから抽出した内容では既存物件と一致せず、新規作成にも至りませんでした。";
    }
    } catch (innerErr) {
      // ジョブ作成後に発生したエラー (Mode A の NOT_FOUND / Prisma 例外 等)。
      // ImportJob を "failed" で finalize し、ImportJobRow も error で1件残す。
      // 失敗の詳細は元のエラーから取り出して errorMessage に格納する。
      failureReason =
        innerErr instanceof Error
          ? innerErr.message
          : "PDF取込中に不明なエラーが発生しました";

      // ベストエフォートで finalize。recovery 自体が失敗しても元のエラーを優先する。
      try {
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            successCount: 0,
            errorCount: 1,
            completedAt: new Date(),
          },
        });
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber: 1,
            status: "error",
            rawData: {
              fileName,
              reason: failureReason,
              extractedAddress: parsed.address ?? null,
              extractedRealEstateNumber: parsed.realEstateNumber ?? null,
              targetPropertyId,
            },
            errorMessage: failureReason,
            createdId: null,
          },
        });
      } catch {
        // finalize 失敗はサイレント（元のエラーを下で再 throw）
      }

      // 元のエラーを再 throw して handleApiError に正規の HTTP ステータスを返させる
      throw innerErr;
    }

    // ---- Finalize: success / silent-fail で分岐 ----
    if (failureReason) {
      // Path 3: silent fail-through。API 自体は 201 を返しつつ、ジョブとしては
      // failed + error 行で記録する。propertyId は null。
      await prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          successCount: 0,
          errorCount: 1,
          completedAt: new Date(),
        },
      });
      await prisma.importJobRow.create({
        data: {
          jobId: job.id,
          rowNumber: 1,
          status: "error",
          rawData: {
            fileName,
            reason: failureReason,
            extractedAddress: parsed.address ?? null,
            extractedRealEstateNumber: parsed.realEstateNumber ?? null,
            targetPropertyId: null,
          },
          errorMessage: failureReason,
          createdId: null,
        },
      });

      await writeAuditLog({
        userId: session.id,
        action: "pdf_import",
        targetTable: "import_jobs",
        targetId: job.id,
        detail: {
          jobId: job.id,
          action: "failed",
          reason: failureReason,
          confidence: parsed.confidence,
          fileName: fileName,
        },
      });

      return apiResponse(
        {
          jobId: job.id,
          action: resultAction,
          propertyId: null,
          parsed,
        },
        201,
      );
    }

    // 成功パス（既存動作）
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        successCount: 1,
        errorCount: 0,
        completedAt: new Date(),
      },
    });

    await prisma.importJobRow.create({
      data: {
        jobId: job.id,
        rowNumber: 1,
        status: "success",
        rawData: {
          realEstateNumber: parsed.realEstateNumber,
          address: parsed.address,
          lotNumber: parsed.lotNumber,
          buildingNumber: parsed.buildingNumber,
          owners: parsed.owners.map((o) => o.name),
        },
        createdId: targetPropertyId,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "pdf_import",
      targetTable: "properties",
      targetId: targetPropertyId ?? undefined,
      detail: {
        jobId: job.id,
        action: resultAction,
        confidence: parsed.confidence,
        fileName: fileName,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        action: resultAction,
        propertyId: targetPropertyId,
        parsed,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
