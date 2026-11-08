/**
 * PDF テキスト抽出ユーティリティ
 *
 * pdf-parse v2 (クラスベース API) を薄くラップし、Buffer から本文テキストを返す。
 * サーバーサイド専用 (Node.js runtime のみ)。
 * next.config.ts で serverExternalPackages: ["pdf-parse"] を設定すること。
 */

import { PDF_READ_TIMEOUT, trackTimedOutPdfRead } from "@/lib/pdf-read-timeout";

export { PDF_READ_TIMEOUT };

/**
 * PDF バイナリから本文テキストを抽出する。
 * @param buffer PDF ファイルの Buffer
 * @param opts.timeoutMs 渡したときだけ、その時間で打ち切って code=PDF_READ_TIMEOUT を投げる
 *   (使い終わった parser は destroy する)。渡さない呼び出しは今までどおり打ち切らない。
 * @returns 抽出されたテキスト (全ページ連結)
 * @throws テキスト抽出に失敗した場合
 */
export async function extractTextFromPdf(
  buffer: Buffer,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  // dynamic import で webpack バンドルを回避
  const { PDFParse } = await import("pdf-parse");

  const parser = new PDFParse({ data: buffer });
  if (opts.timeoutMs === undefined) {
    const result = await parser.getText();
    return result.text;
  }
  // 謄本の名義の比べ(2026-11-08): とても大きい PDF で2分ごとの呼び出しの持ち時間を食わない
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const destroyQuietly = async () => {
    try {
      await parser.destroy();
    } catch {
      // 後始末の失敗は握りつぶす(読めた結果には影響しない)
    }
  };
  const text = parser.getText().then((r) => r.text);
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error("PDF read timed out"), { code: PDF_READ_TIMEOUT }));
      }, opts.timeoutMs);
    });
    return await Promise.race([text, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await destroyQuietly();
    if (timedOut) {
      // 文書の読み込みの最中に打ち切ると、上の destroy は(まだ文書が無いので)何もしない。
      // 読み取りが終わった・失敗した時点でもう一度 destroy して、文書を残さない。
      // (読み取り側の失敗もここで拾う=拾われない例外にしない)
      // 読み取りそのものは止められないので、終わるまで「裏で続いている」として数える(@codex #681)
      trackTimedOutPdfRead(text.then(destroyQuietly, destroyQuietly));
    }
  }
}

/**
 * 先頭の数ページだけの文字(書類の自動判別・2026-10-23)。
 * 判別に使うのは先頭 3,000 文字だけなので、20MB・数十ページの PDF を全部読まない。
 * 使い終わった parser は必ず destroy する(pdf.js の文書が残らないように)。
 * 時間の上限(既定 15 秒)を超えたら null(=判別は名前だけで続ける)。
 */
export async function extractHeadTextFromPdf(
  buffer: Buffer,
  opts: { pages?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const pages = opts.pages ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const text = parser.getText({ first: pages }).then((r) => r.text);
    return await Promise.race([text, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await parser.destroy();
    } catch {
      // 後始末の失敗は握りつぶす(読めた結果には影響しない)
    }
  }
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
