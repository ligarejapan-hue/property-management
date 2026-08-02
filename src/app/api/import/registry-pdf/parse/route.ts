import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import {
  extractTextFromPdf,
  getPdfExtractionSource,
  isPdfBuffer,
  type PdfExtractionSource,
} from "@/lib/pdf-extract";
import { assertImportJsonBodySize } from "@/lib/import-body-size";

const SCANNED_PDF_WARNING =
  "PDF本文を十分に抽出できませんでした。画像化された謄本PDFの可能性があります。OCRは未対応のため、抽出結果を手動で確認してください。";

// ---------- POST /api/import/registry-pdf/parse ----------
// プレビュー専用: PDF または テキストを受け取り、解析結果だけを返す。
// DB への書き込みは行わない。
//
// リクエスト形式:
//   multipart/form-data  → file: PDF binary  (+ optional fileName)
//   application/json     → { text: string, fileName?: string }

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "取込の権限がありません", "FORBIDDEN");
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    let fileName = "registry.pdf";
    let isPdfUpload = false;

    if (contentType.includes("multipart/form-data")) {
      isPdfUpload = true;
      // --- PDF バイナリ受信 ---
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        throw new ApiError(400, "ファイルが指定されていません", "NO_FILE");
      }

      fileName = (file as File).name ?? "registry.pdf";
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
      // body 全体をバッファする前に過大サイズを弾く(2026-08-02 監査: PDF 経路と姿勢を揃える)。

      assertImportJsonBodySize(request);

      const body = await request.json();
      if (!body?.text || typeof body.text !== "string") {
        throw new ApiError(400, "text フィールドが必要です", "NO_TEXT");
      }
      text = body.text;
      fileName = body.fileName ?? "registry.txt";
    }

    // PDF アップロード経路のみ判定。テキスト貼り付けは利用者が意図的に投入しているため embedded_text 固定
    const extractionSource: PdfExtractionSource = isPdfUpload
      ? getPdfExtractionSource(text)
      : "embedded_text";
    const isLikelyScanned = extractionSource === "likely_scanned";

    const parsed = parseRegistryText(text);
    if (isLikelyScanned && !parsed.warnings.includes(SCANNED_PDF_WARNING)) {
      parsed.warnings = [SCANNED_PDF_WARNING, ...parsed.warnings];
    }

    return apiResponse({
      fileName,
      extractedTextLength: text.length,
      extractionSource,
      isLikelyScanned,
      // Phase F-2a: scanned 検知時の UI 強化（テキスト貼り付け導線）用に、
      // 抽出ソース判定と埋込テキスト文字数をまとめて非破壊で返す。
      // 既存 isLikelyScanned / extractionSource は維持。
      // 文字数（length）のみで本文・raw text は含めない（PII / AuditLog 方針と整合）。
      extraction: {
        source: extractionSource,
        embeddedTextLength: text.length,
      },
      parsed,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
