/**
 * PDF テキスト抽出ユーティリティ
 *
 * pdf-parse v2 (クラスベース API) を薄くラップし、Buffer から本文テキストを返す。
 * サーバーサイド専用 (Node.js runtime のみ)。
 * next.config.ts で serverExternalPackages: ["pdf-parse"] を設定すること。
 */

/**
 * PDF バイナリから本文テキストを抽出する。
 * @param buffer PDF ファイルの Buffer
 * @returns 抽出されたテキスト (全ページ連結)
 * @throws テキスト抽出に失敗した場合
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // dynamic import で webpack バンドルを回避
  const { PDFParse } = await import("pdf-parse");

  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

/**
 * PDF Buffer が有効かどうかをチェックする (magic bytes 確認)。
 */
export function isPdfBuffer(buffer: Buffer): boolean {
  // PDF は必ず "%PDF-" (25 50 44 46 2D) で始まる
  return (
    buffer.length > 4 &&
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46    // F
  );
}

/** スキャン/画像化PDFの可能性判定で「極端に短い」とみなす閾値 (文字数)。 */
export const SCANNED_PDF_TEXT_LENGTH_THRESHOLD = 50;

export type PdfExtractionSource = "embedded_text" | "likely_scanned";

/**
 * PDF から抽出したテキストが「画像化された謄本PDFの可能性が高い」かを判定する。
 * 空 / whitespace のみ / 閾値未満は true。OCRは未実装のため、UI 警告用途のみ。
 */
export function isLikelyScannedPdf(text: string): boolean {
  if (typeof text !== "string") return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return trimmed.length < SCANNED_PDF_TEXT_LENGTH_THRESHOLD;
}

/** isLikelyScannedPdf を判定タグに変換する薄いラッパ。 */
export function getPdfExtractionSource(text: string): PdfExtractionSource {
  return isLikelyScannedPdf(text) ? "likely_scanned" : "embedded_text";
}
