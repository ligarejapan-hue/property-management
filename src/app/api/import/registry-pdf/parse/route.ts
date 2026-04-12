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
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";

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

    if (contentType.includes("multipart/form-data")) {
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
      const body = await request.json();
      if (!body?.text || typeof body.text !== "string") {
        throw new ApiError(400, "text フィールドが必要です", "NO_TEXT");
      }
      text = body.text;
      fileName = body.fileName ?? "registry.txt";
    }

    const parsed = parseRegistryText(text);

    return apiResponse({
      fileName,
      extractedTextLength: text.length,
      // 開発デバッグ用: 抽出テキスト先頭 600 文字 (本番では除去)
      _rawTextPreview: process.env.NODE_ENV !== "production" ? text.slice(0, 600) : undefined,
      parsed,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
