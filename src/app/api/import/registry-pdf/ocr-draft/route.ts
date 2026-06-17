/**
 * POST /api/import/registry-pdf/ocr-draft
 *
 * scanned/printed 謄本 PDF（likely_scanned）に対し、ローカル OCR で「下書きテキスト」を
 * 生成し、既存 parseRegistryText の preview 形で返す（registry extraction strategy の
 * local_ocr 経路）。digital-native PDF の主経路（既存 /parse = pdf_text）は不変。
 *
 *  - admin 限定 + import:write（J1）。OCR 未設定なら 501（現行挙動維持）。
 *  - **DB 書込なし**（preview のみ。永続は既存 confirm = /api/import/registry-pdf のみ）。
 *  - raw OCR text・PDF 本文は非永続・非ログ。OCR 失敗は 502（UI は手動貼付へ fallback）。
 */
import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import {
  isRegistryOcrConfigured,
  requestOcrText,
  RegistryOcrError,
  MAX_PDF_BYTES,
} from "@/lib/registry-ocr/client";
import { reliabilityFromConfidence } from "@/lib/registry-ocr/types";

export const runtime = "nodejs";

// PDF magic header（%PDF-）。非 PDF を OCR へ送らない。
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

interface OcrAuditDetail {
  status: "succeeded" | "failed";
  pages: number;
  charCount: number;
  previewGenerated: boolean;
  errorCode: string | null;
}

// 非PII 監査（raw text / PDF 本文は載せない）。失敗してもレスポンスを壊さない。
async function safeAudit(userId: string, detail: OcrAuditDetail): Promise<void> {
  try {
    await writeAuditLog({
      userId,
      action: "registry_ocr_draft",
      targetTable: "import_jobs",
      detail,
    });
  } catch {
    /* audit 失敗は無視 */
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    // J1: 新規横断 OCR ゆえ明示 admin 限定。
    if (session.role !== "admin") {
      throw new ApiError(403, "OCR下書きは管理者のみ利用できます", "FORBIDDEN");
    }
    // configured gate（未設定で 501＝現行挙動維持・auto-fetch と同型）。
    if (!isRegistryOcrConfigured()) {
      throw new ApiError(
        501,
        "OCR サービスは未設定です",
        "REGISTRY_OCR_NOT_CONFIGURED",
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError(400, "PDF ファイルが必要です", "VALIDATION_ERROR");
    }
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "PDF ファイルが必要です", "VALIDATION_ERROR");
    }
    // buffering 前に size を弾く（過大ファイルを丸ごとメモリに載せない）。
    if (file.size > MAX_PDF_BYTES) {
      throw new ApiError(413, "PDF が大きすぎます", "PAYLOAD_TOO_LARGE");
    }
    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikePdf(pdfBytes)) {
      throw new ApiError(
        400,
        "PDF 形式のファイルではありません",
        "VALIDATION_ERROR",
      );
    }

    // OCR 実行。失敗は手動貼付 fallback 用の 502 へ（既存取込は落とさない）。
    let ocrText: string;
    let ocrPages: number;
    let ocrWarnings: string[];
    try {
      const ocr = await requestOcrText(pdfBytes);
      ocrText = ocr.text;
      ocrPages = ocr.pages;
      ocrWarnings = ocr.warnings;
    } catch (e) {
      const errorCode = e instanceof RegistryOcrError ? e.code : "OCR_ERROR";
      await safeAudit(session.id, {
        status: "failed",
        pages: 0,
        charCount: 0,
        previewGenerated: false,
        errorCode,
      });
      throw new ApiError(
        502,
        "OCR で下書きを生成できませんでした。テキスト貼り付けをご利用ください。",
        "REGISTRY_OCR_FAILED",
      );
    }

    // 既存 parser で preview を生成（DB 書込なし・raw OCR は非永続）。
    const parsed = parseRegistryText(ocrText);

    await safeAudit(session.id, {
      status: "succeeded",
      pages: ocrPages,
      charCount: ocrText.length,
      previewGenerated: true,
      errorCode: null,
    });

    return apiResponse({
      fileName: file.name || "registry-ocr.pdf",
      extractedTextLength: ocrText.length,
      extractionSource: "scanned_pdf",
      extractionMethod: "local_ocr",
      isLikelyScanned: true,
      extraction: {
        source: "scanned_pdf",
        method: "local_ocr",
        reliability: reliabilityFromConfidence(parsed.confidence),
      },
      ocrWarnings,
      parsed,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
