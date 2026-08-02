/**
 * JSON body（CSV/XLSX 取込）の**パース前**サイズガード。
 *
 * 2026-08-02 監査: PDF 取込は Content-Length で事前に弾いていた（411/413）のに、
 * CSV/XLSX 取込は `request.json()` で body 全体をバッファしてから
 * `MAX_IMPORT_DECODED_BYTES`(10MB) を見ていた＝**過大 body でメモリを圧迫できる**
 * 非対称があった。同じ姿勢に揃える。
 *
 * 上限は「10MB の CSV/XLSX が通る」ことを基準に、JSON エスケープと base64 の
 * 膨張（base64 は約1.33倍）を見込んで余裕を持たせる。
 */
import { ApiError } from "@/lib/api-helpers";

/** JSON body の上限（バイト）。10MB のファイル + base64 膨張 + JSON 構造の余裕。 */
export const MAX_IMPORT_JSON_BODY_BYTES = 20 * 1024 * 1024;

/**
 * Content-Length を検査し、欠落/非数値は 411、過大は 413 を投げる。
 * ⚠`request.json()` を呼ぶ**前**に実行すること（呼んだ後では意味がない）。
 * ブラウザの fetch は JSON body に必ず Content-Length を付けるため正規経路に影響なし。
 */
export function assertImportJsonBodySize(
  request: { headers: { get(name: string): string | null } },
  maxBytes: number = MAX_IMPORT_JSON_BODY_BYTES,
): void {
  const header = request.headers.get("content-length");
  // ⚠空文字は Number("")=0 で「有限」判定を通ってしまう(自テストで検出)。
  // 欠落・空・非数値・負値はすべて 411 で弾く。
  const length = header === null ? NaN : Number(header.trim());
  if (
    header === null ||
    header.trim() === "" ||
    !Number.isFinite(length) ||
    length < 0
  ) {
    throw new ApiError(411, "Content-Length ヘッダが必要です", "LENGTH_REQUIRED");
  }
  if (length > maxBytes) {
    const mb = Math.floor(maxBytes / (1024 * 1024));
    throw new ApiError(
      413,
      `送信データが上限(${mb}MB)を超えています。ファイルを分割して取り込んでください`,
      "PAYLOAD_TOO_LARGE",
    );
  }
}
