import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  processRegistryPdf,
  editedImportSchema,
  registryPdfJsonSchema,
  type EditedImport,
} from "@/lib/registry-pdf/process";

// ---------- POST /api/import/registry-pdf ----------
// リクエスト形式:
//   multipart/form-data → file: PDF binary (+ optional propertyId, fileName)
//   application/json    → { text, propertyId?, fileName? }  (後方互換)
//
// PR1: 認証・入力受け口（multipart/text）だけを担当し、取込の中核処理は
// processRegistryPdf（@/lib/registry-pdf/process）へ委譲する。挙動・レスポンス・
// ステータスコードは従来と不変。

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
    // A-2b: multipart(PDF binary) のときのみ本体を保持し、取込成功後に
    // Attachment(type="registry") として保存する。text 貼り付けは null のまま
    // （PDF が存在しないため Attachment を作成しない）。
    let pdfBuffer: Buffer | null = null;

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

      // A-2b: 検証済み PDF バイナリを取込成功後の Attachment 保存用に保持する。
      pdfBuffer = buffer;

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

    // 中核処理（parse → ImportJob → Mode A/B → 所有者反映 → finalize →
    // Attachment 保存 → AuditLog → body 生成）は共通関数へ委譲。
    const result = await processRegistryPdf({
      session,
      text,
      propertyId,
      fileName,
      edited,
      pdfBuffer,
    });

    return apiResponse(result, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
