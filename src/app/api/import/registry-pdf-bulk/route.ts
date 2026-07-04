import { NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma";
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
import { isPdfBuffer } from "@/lib/pdf-extract";
import { getStorage } from "@/lib/storage";
import { parseRegistryPdfBulkFilename } from "@/lib/registry-pdf-bulk/filename";
import { registryPdfBulkStagingKey } from "@/lib/registry-pdf-bulk/staging";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";

// multipart を Buffer 化するため Node ランタイム必須(既存 ocr-draft と同じ)
export const runtime = "nodejs";

// 承認済み仕様: 最大100ファイル/合計100MB/1ファイル5MB
const MAX_BULK_FILES = 100;
const MAX_BULK_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BULK_TOTAL_BYTES = 100 * 1024 * 1024;
// multipart envelope(boundary/ヘッダ)の許容オーバーヘッド(100ファイル分)
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

interface RowSeed {
  rowNumber: number;
  status: "pending" | "error";
  rawData: Record<string, string>;
  errorMessage: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }

    // formData() で body 全体をバッファする前に Content-Length で過大 body を弾く
    // ヘッダ欠落/非数値(chunked 等でガードを回避しうる)は 411 で拒否する。
    // ブラウザの fetch+FormData は必ず Content-Length を付けるため正規クライアントに影響なし。
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = Number(contentLengthHeader);
    if (contentLengthHeader === null || !Number.isFinite(contentLength)) {
      throw new ApiError(411, "Content-Length ヘッダが必要です", "LENGTH_REQUIRED");
    }
    if (contentLength > MAX_BULK_TOTAL_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw new ApiError(
        413,
        "アップロード合計サイズが上限(100MB)を超えています。分割して投入してください",
        "PAYLOAD_TOO_LARGE",
      );
    }

    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      throw new ApiError(400, "ファイルが指定されていません", "NO_FILE");
    }
    if (files.length > MAX_BULK_FILES) {
      throw new ApiError(
        422,
        `一度に投入できるのは${MAX_BULK_FILES}ファイルまでです。分割して投入してください`,
        "TOO_MANY_FILES",
      );
    }
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_BULK_TOTAL_BYTES) {
      throw new ApiError(
        413,
        "アップロード合計サイズが上限(100MB)を超えています。分割して投入してください",
        "PAYLOAD_TOO_LARGE",
      );
    }

    const job = await prisma.importJob.create({
      data: {
        jobType: "registry_pdf_bulk",
        fileName: `所有者事項PDF一括 (${files.length}件)`,
        status: "pending",
        totalRows: files.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
      select: { id: true },
    });

    const storage = getStorage();
    const rows: RowSeed[] = [];
    const stagedKeys: string[] = [];
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rowNumber = i + 1;
      const fileName = file.name || `file-${rowNumber}.pdf`;

      if (file.size > MAX_BULK_FILE_BYTES) {
        rows.push({
          rowNumber,
          status: "error",
          rawData: { fileName, reason: "file_too_large" },
          errorMessage: "1ファイルの上限(5MB)を超えています",
        });
        rejectedCount++;
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        rows.push({
          rowNumber,
          status: "error",
          rawData: { fileName, reason: "not_pdf" },
          errorMessage: "PDFファイルではありません",
        });
        rejectedCount++;
        continue;
      }

      const parsed = parseRegistryPdfBulkFilename(fileName);
      const stagedKey = registryPdfBulkStagingKey(job.id, rowNumber);
      try {
        await storage.upload(buffer, {
          key: stagedKey,
          mimeType: "application/pdf",
          fileName,
        });
      } catch (err) {
        console.error("registry-pdf-bulk: staging upload failed:", err);
        rows.push({
          rowNumber,
          status: "error",
          rawData: { fileName, reason: "staging_failed" },
          errorMessage: "サーバへの一時保存に失敗しました",
        });
        rejectedCount++;
        continue;
      }
      stagedKeys.push(stagedKey);
      rows.push({
        rowNumber,
        status: "pending",
        rawData: {
          fileName,
          stagedKey,
          ...(parsed
            ? {
                requestNumber: parsed.requestNumber,
                location: parsed.location,
                ...(parsed.kind ? { kind: parsed.kind } : {}),
              }
            : {}),
        },
        errorMessage: null,
      });
      acceptedCount++;
    }

    try {
      await prisma.importJobRow.createMany({
        data: rows.map((r) => ({
          jobId: job.id,
          rowNumber: r.rowNumber,
          status: r.status,
          rawData: r.rawData as Prisma.InputJsonValue,
          errorMessage: r.errorMessage,
        })),
      });

      enqueueRegistryPdfBulkJob(job.id);
    } catch (err) {
      // 行作成(またはenqueue)に失敗すると、ジョブが status:"pending"・行0件のまま
      // 孤児化し(stuck検知はprocessingのみ対象で不可視)、アップ済みstagingも
      // 参照されず残る。best-effort で掃除してからジョブを failed にし、元の例外を rethrow する。
      for (const key of stagedKeys) {
        try {
          await storage.delete(key);
        } catch (delErr) {
          console.error("registry-pdf-bulk: orphaned staging cleanup failed:", key, delErr);
        }
      }
      try {
        await prisma.importJob.update({
          where: { id: job.id },
          data: { status: "failed", completedAt: new Date() },
        });
      } catch (updateErr) {
        console.error("registry-pdf-bulk: failed-status update failed:", updateErr);
      }
      throw err;
    }

    try {
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_bulk_upload",
        targetTable: "import_jobs",
        targetId: job.id,
        detail: { fileCount: files.length, acceptedCount, rejectedCount },
      });
    } catch (e) {
      console.error("registry-pdf-bulk: audit failed (non-fatal):", e);
    }

    return apiResponse(
      {
        jobId: job.id,
        totalRows: files.length,
        acceptedCount,
        rejectedCount,
      },
      202,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
