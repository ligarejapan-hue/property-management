/**
 * 大きい PDF の自動圧縮 — 決まりごと(純関数)。
 *
 * 発注者決定(2026-10-09):
 *   - **謄本以外の添付すべて**で、PDF が上限(MAX_FILE_SIZE=8MB)を超えたら自動で縮める。
 *     謄本は課金して取った原本なので縮めない(入口で type を見て外す)。
 *   - **元のファイル(圧縮前)は残さない**。元は取り直せる(SRE の査定報告書など)。
 *   - 上限以下の PDF には手を触れない(劣化なしの圧縮でも、触る理由が無い)。
 *
 * ⚠ Prisma / next / node:fs を import しないこと(純関数を保つ)。
 */

/**
 * 圧縮する前の PDF として受け取ってよい大きさ。これを超えるものは縮めても
 * 上限に届く見込みが薄く、受け取るだけでメモリを使うので、最初に断る。
 * 実測: SRE AI査定の報告書(46ページ)18.8MB → 7.9MB。
 */
export const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 「18.8MB」のような表示(小数1桁)。 */
export function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export type PdfCompressFailure =
  | "too_large"
  | "encrypted"
  | "invalid_pdf"
  | "unavailable"
  | "error";

/** 縮められなかったときに利用者へ出す文言(上限の数字は定数から組み立てる)。 */
export function compressFailureMessage(
  reason: PdfCompressFailure,
  sizes: { inBytes: number; bestBytes: number | null; limitBytes: number },
): string {
  const limit = formatMb(sizes.limitBytes).replace(".0MB", "MB");
  switch (reason) {
    case "too_large":
      return (
        `PDFを自動で圧縮しましたが、上限(${limit})まで小さくできませんでした` +
        `(元 ${formatMb(sizes.inBytes)}` +
        (sizes.bestBytes !== null ? ` → 最小 ${formatMb(sizes.bestBytes)}` : "") +
        `)。ページを分けて保存してください。`
      );
    case "encrypted":
      return `パスワード付きのPDFは自動で圧縮できません。${limit}以下にしてからアップロードしてください。`;
    case "invalid_pdf":
      return `PDFとして読み取れないため、自動で圧縮できませんでした。${limit}以下にしてからアップロードしてください。`;
    case "unavailable":
    case "error":
      return `大きなPDFを圧縮できませんでした。${limit}以下にしてからアップロードしてください。`;
  }
}

/** 圧縮の席が埋まっているとき(本文を読む前に断る)。 */
export function compressBusyMessage(): string {
  return "いま別の大きいPDFを圧縮しています。1分ほど待ってから、もう一度お試しください。";
}

/** PDF として扱うか: MIME が PDF、または MIME が空・不明(octet-stream)で拡張子が .pdf。 */
export function isPdfByMimeOrName(mimeType: string, fileName: string): boolean {
  if (mimeType === "application/pdf") return true;
  const unknownMime = mimeType === "" || mimeType === "application/octet-stream";
  return unknownMime && fileName.toLowerCase().endsWith(".pdf");
}

/** 受け取る前に断るときの文言。 */
export function pdfTooLargeToAcceptMessage(): string {
  return `PDFが大きすぎます(${formatMb(MAX_PDF_UPLOAD_BYTES).replace(".0MB", "MB")}まで。8MBを超えるPDFは自動で圧縮します)`;
}
