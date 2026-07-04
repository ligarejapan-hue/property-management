import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { getStorage, validateFile, ALLOWED_ATTACHMENT_MIMES } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";
import { matchProperty, type PropertyIndex } from "./match";

/**
 * 所有者事項PDF一括取込: 1行(=1ファイル)の処理。
 *
 * 流れ: pending確認 → 請求番号の重複スキップ → 物件突合
 *       (ファイル名の所在 → だめならPDF内容の所在/不動産番号) →
 *       Attachment(type=registry)作成 → 行を atomic に確定。
 *
 * - 確定は必ず `updateMany({ where: { id, status: "pending" } })` で行う。
 *   ワーカーは単一直列だが、再開の二重enqueueや再起動後の残骸に対して
 *   「pending の行だけが確定できる」ことで冪等性を担保する。
 * - クラッシュで「添付済みなのに行がpendingのまま」になった場合も、
 *   再処理時に請求番号の重複チェックが skipped に倒すので二重添付されない。
 * - rawData/エラーメッセージに所有者の氏名・住所は入れない(PII規律)。
 */

export interface BulkRowExecutor {
  id: string;
  role: string;
}

export type BulkRowOutcome =
  | "success"
  | "skipped"
  | "needs_review"
  | "error"
  | "noop";

interface BulkRawData {
  fileName?: string;
  stagedKey?: string;
  requestNumber?: string;
  location?: string;
  kind?: string;
  [key: string]: unknown;
}

async function finalizeRow(
  rowId: string,
  data: {
    status: "success" | "skipped" | "needs_review" | "error";
    errorMessage: string | null;
    createdId: string | null;
    rawData: Record<string, unknown>;
  },
): Promise<boolean> {
  const res = await prisma.importJobRow.updateMany({
    where: { id: rowId, status: "pending" },
    data: {
      ...data,
      // Prisma の JSON カラムは InputJsonValue を要求する。呼び出し側では
      // 可読性のため Record<string, unknown> で組み立て、書き込み境界でのみ cast する。
      rawData: data.rawData as Prisma.InputJsonValue,
    },
  });
  return res.count === 1;
}

export async function processRegistryPdfBulkRow(args: {
  jobId: string;
  rowId: string;
  index: PropertyIndex;
  executor: BulkRowExecutor;
}): Promise<BulkRowOutcome> {
  const { jobId, rowId, index, executor } = args;
  const row = await prisma.importJobRow.findUnique({ where: { id: rowId } });
  if (!row || row.jobId !== jobId || row.status !== "pending") {
    return "noop";
  }
  const raw = ((row.rawData ?? {}) as BulkRawData) ?? {};
  const fileName = typeof raw.fileName === "string" ? raw.fileName : "";
  const stagedKey = typeof raw.stagedKey === "string" ? raw.stagedKey : "";
  const requestNumber =
    typeof raw.requestNumber === "string" && raw.requestNumber !== ""
      ? raw.requestNumber
      : null;
  const location =
    typeof raw.location === "string" && raw.location !== ""
      ? raw.location
      : null;
  const storage = getStorage();

  try {
    if (!stagedKey) {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage: "取込データが不完全です(保管キーなし)",
        createdId: null,
        rawData: { ...raw, reason: "no_staged_key" },
      });
      return "error";
    }

    // 1. 請求番号による重複スキップ(exeの「取得済みはスキップ」と同発想)
    if (requestNumber) {
      const dup = await prisma.attachment.findFirst({
        where: {
          type: "registry",
          isDeleted: false,
          fileName: { contains: requestNumber },
        },
        select: { id: true, propertyId: true },
      });
      if (dup) {
        await finalizeRow(rowId, {
          status: "skipped",
          errorMessage: `重複: 請求番号 ${requestNumber} は取込済みです`,
          createdId: dup.propertyId,
          rawData: { ...raw, reason: "duplicate_request_number" },
        });
        try {
          await storage.delete(stagedKey);
        } catch (e) {
          console.error("registry-pdf-bulk: staging delete failed:", e);
        }
        return "skipped";
      }
    }

    // 2. 物件突合: まずファイル名の所在、だめならPDF内容でフォールバック
    let buffer: Buffer | null = null;
    const readStaged = async (): Promise<Buffer | null> => {
      if (buffer) return buffer;
      const res = await storage.read(stagedKey);
      if (!res) return null;
      buffer = res.body;
      return buffer;
    };

    let match = matchProperty(index, { location });
    let matchedVia: "filename" | "content" = "filename";
    if (match.status === "not_found") {
      const buf = await readStaged();
      if (!buf) {
        await finalizeRow(rowId, {
          status: "error",
          errorMessage:
            "保管中のPDFを読み取れませんでした(整理済みの可能性があります)",
          createdId: null,
          rawData: { ...raw, reason: "staged_file_missing" },
        });
        return "error";
      }
      try {
        const text = await extractTextFromPdf(buf);
        const parsed = parseRegistryText(text);
        const fallback = matchProperty(index, {
          location: parsed.address,
          realEstateNumber: parsed.realEstateNumber,
        });
        if (fallback.status !== "not_found") {
          match = fallback;
          matchedVia = "content";
        }
      } catch (e) {
        // 内容フォールバックの失敗は「一致なし」として扱う(下の needs_review へ)
        console.error("registry-pdf-bulk: content fallback failed:", e);
      }
    }

    if (match.status === "multiple") {
      await finalizeRow(rowId, {
        status: "needs_review",
        errorMessage: `候補が複数あります(${match.count}件)。物件を指定して添付してください`,
        createdId: null,
        rawData: { ...raw, reason: "multiple_candidates" },
      });
      return "needs_review";
    }
    if (match.status === "not_found") {
      await finalizeRow(rowId, {
        status: "needs_review",
        errorMessage:
          "一致する物件が見つかりません。物件を指定して添付してください",
        createdId: null,
        rawData: { ...raw, reason: "not_found" },
      });
      return "needs_review";
    }

    // 3. アクセス権(既存 A-2b と同じ: 書込直前に対象物件の権限を確認)
    const target = await prisma.property.findUnique({
      where: { id: match.propertyId },
      select: { createdBy: true, assignedTo: true },
    });
    if (!target || !canAccessPropertyRecord(executor, target)) {
      await finalizeRow(rowId, {
        status: "needs_review",
        errorMessage:
          "一致した物件へのアクセス権が無いため添付できません。物件を指定して添付してください",
        createdId: null,
        rawData: { ...raw, reason: "no_access" },
      });
      return "needs_review";
    }

    // 4. 添付(既存 A-2b パターン: validate → upload → create → 失敗時は孤児削除)
    const buf = await readStaged();
    if (!buf) {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage:
          "保管中のPDFを読み取れませんでした(整理済みの可能性があります)",
        createdId: null,
        rawData: { ...raw, reason: "staged_file_missing" },
      });
      return "error";
    }
    const validationError = validateFile(
      buf.length,
      "application/pdf",
      ALLOWED_ATTACHMENT_MIMES,
    );
    if (validationError) {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage: validationError,
        createdId: null,
        rawData: { ...raw, reason: "validation_failed" },
      });
      return "error";
    }
    let uploadedKey: string | null = null;
    let attachmentId: string;
    try {
      const key = `properties/${match.propertyId}/registry/${Date.now()}-${randomUUID()}.pdf`;
      const uploaded = await storage.upload(buf, {
        key,
        mimeType: "application/pdf",
        fileName: fileName || "registry.pdf",
      });
      uploadedKey = uploaded.key;
      const attachment = await prisma.attachment.create({
        data: {
          targetType: "property",
          targetId: match.propertyId,
          propertyId: match.propertyId,
          type: "registry",
          fileName: fileName || "registry.pdf",
          fileUrl: uploaded.url,
          fileSize: buf.length,
          mimeType: "application/pdf",
          uploadedBy: executor.id,
        },
        select: { id: true },
      });
      attachmentId = attachment.id;
    } catch (err) {
      if (uploadedKey) {
        try {
          await storage.delete(uploadedKey);
        } catch (delErr) {
          console.error(
            "registry-pdf-bulk: orphan cleanup failed:",
            delErr,
          );
        }
      }
      throw err;
    }

    const finalized = await finalizeRow(rowId, {
      status: "success",
      errorMessage: null,
      createdId: match.propertyId,
      rawData: {
        ...raw,
        attachmentId,
        matchedBy: match.matchedBy,
        matchedVia,
      },
    });
    if (finalized) {
      try {
        await storage.delete(stagedKey);
      } catch (e) {
        console.error("registry-pdf-bulk: staging delete failed:", e);
      }
      try {
        await writeAuditLog({
          userId: executor.id,
          action: "create",
          targetTable: "attachments",
          targetId: attachmentId,
          detail: { propertyId: match.propertyId, fileName, jobId },
        });
      } catch (e) {
        console.error("registry-pdf-bulk: audit failed (non-fatal):", e);
      }
    }
    return "success";
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "PDF処理中に不明なエラーが発生しました";
    try {
      await finalizeRow(rowId, {
        status: "error",
        errorMessage: message.slice(0, 500),
        createdId: null,
        rawData: { ...raw, reason: "unexpected_error" },
      });
    } catch (finalizeErr) {
      console.error("registry-pdf-bulk: finalize failed:", finalizeErr);
    }
    return "error";
  }
}
