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
import { normalizeName, normalizeAddress } from "@/lib/normalize";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { buildErrorRawDataExtras } from "@/lib/import-error-display";
import {
  decideCorporateImport,
  emptyCorporateImportSummary,
  tallyCorporateDecision,
  corporateImportMessage,
  appendImportMessage,
  type CorporateImportDecision,
} from "@/lib/owner-corporate-import";

// 確定取込で UI が編集した結果（A-2a）。サーバ再 parse より優先する。
// クライアント送信値は無検証で信用せず zod で型・件数を検証する。
const editedImportSchema = z.object({
  fields: z
    .object({
      realEstateNumber: z.string().nullish(),
      address: z.string().nullish(),
      lotNumber: z.string().nullish(),
      buildingNumber: z.string().nullish(),
      landCategory: z.string().nullish(),
      area: z.string().nullish(),
    })
    .optional(),
  owners: z
    .array(
      z.object({
        name: z.string(),
        address: z.string().nullish(),
        share: z.string().nullish(),
      }),
    )
    .max(100, "所有者が多すぎます")
    .optional(),
});
type EditedImport = z.infer<typeof editedImportSchema>;

const registryPdfJsonSchema = z.object({
  /** Extracted text from the PDF (テキスト貼り付けモード) */
  text: z.string().min(1, "テキストは必須です"),
  /** Optional: property ID to update instead of creating new */
  propertyId: z.string().uuid().optional().nullable(),
  /** File name for audit purposes */
  fileName: z.string().optional(),
  /** UI で編集した確定データ（任意）。再 parse 結果より優先して反映する。 */
  edited: editedImportSchema.optional(),
});

// parse 結果に UI 編集値をマージ（編集優先）。下流の Mode A/B は
// マージ後の parsed をそのまま使うため、所有者反映・物件更新ロジックは不変。
function applyEditedToParsed(
  parsed: ReturnType<typeof parseRegistryText>,
  edited: EditedImport | undefined,
): ReturnType<typeof parseRegistryText> {
  if (!edited) return parsed;
  const nz = (v: string | null | undefined): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t === "" ? null : t;
  };
  if (edited.fields) {
    parsed.realEstateNumber = nz(edited.fields.realEstateNumber);
    parsed.address = nz(edited.fields.address);
    parsed.lotNumber = nz(edited.fields.lotNumber);
    parsed.buildingNumber = nz(edited.fields.buildingNumber);
  }
  if (edited.owners) {
    parsed.owners = edited.owners
      .map((o) => ({
        name: (o.name ?? "").trim(),
        address: nz(o.address),
        share: nz(o.share),
      }))
      .filter((o) => o.name.length > 0);
  }
  return parsed;
}

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
    let edited: EditedImport | undefined;

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

      // UI 編集データ（任意）。multipart では JSON 文字列で受け取り zod 検証する。
      const editedRaw = formData.get("edited");
      if (typeof editedRaw === "string" && editedRaw.trim() !== "") {
        let editedJson: unknown;
        try {
          editedJson = JSON.parse(editedRaw);
        } catch {
          throw new ApiError(400, "edited が不正な JSON です", "INVALID_EDITED");
        }
        edited = editedImportSchema.parse(editedJson);
      }

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
      edited = data.edited;
    }

    // Parse the registry text（UI 編集値があれば再 parse より優先してマージ）
    const parsed = applyEditedToParsed(parseRegistryText(text), edited);

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
    // Phase D: 法人番号自動検出のサマリ + 行 errorMessage 集約
    const corporateSummary = emptyCorporateImportSummary();
    let rowCorporateMessage: string | null = null;
    const recordCorporateDecision = (decision: CorporateImportDecision) => {
      tallyCorporateDecision(corporateSummary, decision);
      const msg = corporateImportMessage(decision);
      if (msg) {
        rowCorporateMessage = appendImportMessage(rowCorporateMessage, msg);
      }
    };
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

        // address あり → normalizeName + normalizeAddress で既存 Owner 検索
        // address なし → name のみでの自動統合はしない（同姓同名の別人を誤統合しないため）
        // archived owner は通常の取込候補から除外（Phase 2-A）。
        let candidateOwnerId: string | null = null;
        // Phase D: 既存 Owner ヒット時の corporateNumber 競合判定に使う
        let candidateCorporateNumber: string | null = null;

        if (ownerInfo.address) {
          const normName = normalizeName(ownerInfo.name);
          const normAddr = normalizeAddress(ownerInfo.address);
          const candidates = await prisma.owner.findMany({
            where: { address: { not: null }, isArchived: false },
            select: { id: true, name: true, address: true, corporateNumber: true },
          });
          const hit = candidates.find(
            (c) =>
              normalizeName(c.name) === normName &&
              normalizeAddress(c.address!) === normAddr,
          );
          candidateOwnerId = hit?.id ?? null;
          candidateCorporateNumber = hit?.corporateNumber ?? null;
        }

        // 既存 owner を使うパス: lookup と PropertyOwner.create の間に concurrent
        // archive が走った場合に archived owner に link してしまうのを防ぐ。
        // transaction 内で owner 行を updateMany でロック + isArchived=false 再確認 →
        // PropertyOwner 作成までを 1 つの tx に閉じる。count=0 ならフォールバックで
        // 新規 active Owner を作成する。
        let resolvedOwnerId: string | null = null;
        if (candidateOwnerId) {
          const reuseLinked = await prisma.$transaction(async (tx) => {
            const lock = await tx.owner.updateMany({
              where: { id: candidateOwnerId!, isArchived: false },
              data: { updatedAt: new Date() },
            });
            if (lock.count === 0) {
              return false;
            }
            const existingLink = await tx.propertyOwner.findFirst({
              where: { propertyId, ownerId: candidateOwnerId! },
              select: { propertyId: true },
            });
            if (!existingLink) {
              await tx.propertyOwner.create({
                data: {
                  propertyId,
                  ownerId: candidateOwnerId!,
                  relationship: ownerInfo.share ? "共有者" : "所有者",
                },
              });
            }
            return true;
          });
          if (reuseLinked) {
            resolvedOwnerId = candidateOwnerId;
          }
          // 競合検出時は resolvedOwnerId=null のまま下のフォールバックへ
        }

        // Phase D: reuse 成功判定。
        // `resolvedOwnerId === candidateOwnerId` だけだと両方 null のとき true になり、
        // (a) updateMany が id:null で実行されてしまう
        // (b) recordCorporateDecision が reuse 側と create 側の二重で呼ばれてしまう
        // 上記 2 件の Codex P1/P2 を防ぐため、両方 non-null かつ等しいことを要求する。
        const reusedExistingOwner =
          resolvedOwnerId !== null &&
          candidateOwnerId !== null &&
          resolvedOwnerId === candidateOwnerId;

        // reuse 成功時のみ既存 corporateNumber と比較、それ以外は existing=null として計算。
        const cnDecision = decideCorporateImport(
          { name: ownerInfo.name, address: ownerInfo.address ?? null },
          reusedExistingOwner ? candidateCorporateNumber : null,
        );

        // reuse 成功時: 既存 owner が corporateNumber 空ならここで埋める。
        // where 条件で corporateNumber: null を要求し、race 時は count=0 で自動上書きを防ぐ。
        if (
          reusedExistingOwner &&
          cnDecision.action === "save" &&
          cnDecision.corporateNumber
        ) {
          const cnUpdate = await prisma.owner.updateMany({
            where: { id: candidateOwnerId!, corporateNumber: null },
            data: { corporateNumber: cnDecision.corporateNumber },
          });
          recordCorporateDecision(
            cnUpdate.count === 0
              ? { action: "noop", corporateNumber: null }
              : cnDecision,
          );
        } else if (reusedExistingOwner) {
          // reuse 成功 + save 以外（noop / multi / conflict / none） → そのまま集計
          recordCorporateDecision(cnDecision);
        }

        if (!resolvedOwnerId) {
          // 新規 Owner 作成 + link（dedup ヒットなし、または archive race で fallback）。
          // 新規 owner は他 tx から見えないため archive 競合はない。
          // archive race fallback の場合も「新規 owner なので existing=null」で再評価する。
          const cnDecisionForCreate =
            candidateOwnerId === null
              ? cnDecision
              : decideCorporateImport(
                  { name: ownerInfo.name, address: ownerInfo.address ?? null },
                  null,
                );
          const created = await prisma.owner.create({
            data: {
              name: ownerInfo.name,
              ...(ownerInfo.address ? { address: ownerInfo.address } : {}),
              // Phase D: 候補 1 件のみ採用、複数 / 競合は乗せない
              ...(cnDecisionForCreate.action === "save" && cnDecisionForCreate.corporateNumber
                ? { corporateNumber: cnDecisionForCreate.corporateNumber }
                : {}),
            },
            select: { id: true },
          });
          resolvedOwnerId = created.id;
          recordCorporateDecision(cnDecisionForCreate);

          const existingLink = await prisma.propertyOwner.findFirst({
            where: { propertyId, ownerId: resolvedOwnerId },
          });
          if (!existingLink) {
            await prisma.propertyOwner.create({
              data: {
                propertyId,
                ownerId: resolvedOwnerId,
                relationship: ownerInfo.share ? "共有者" : "所有者",
              },
            });
          }
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
              ...buildErrorRawDataExtras(failureReason, null),
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
            ...buildErrorRawDataExtras(failureReason, null),
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
        // Phase D: 法人番号スキップ情報のみ追記（生値・会社名・住所は含めない）。
        errorMessage: appendImportMessage(null, rowCorporateMessage),
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
        // Phase D: 法人番号自動検出のサマリ。生値・会社名・住所・候補リストは含めない。
        corporateNumber: corporateSummary,
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
