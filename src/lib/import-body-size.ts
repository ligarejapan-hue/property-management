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

/**
 * JSON body の上限（バイト・1ファイル経路）。
 *
 * ⚠このガードの目的は「**青天井の body を止める**」ことであって、per-file の
 * 上限(MAX_IMPORT_DECODED_BYTES=10MB)を厳しくすることではない。よって
 * per-file 検証が通す入力は必ずここも通るよう、十分な余裕を取る（Codex #349 R2 P2）:
 *   - CSV テキストは JSON 文字列化で最悪 **6 倍**（制御文字は 6 文字のエスケープに
 *     なる。`"` や `\` の 2 倍より厳しいこの値が真の worst case・Codex #349 R9 P2）
 *   - xlsx は base64 で約 1.34 倍
 *   - さらにキー名・改行等の構造分
 * → 10MB × 6 = 60MB を**下限**とし、その上に余白を足して 64MB。
 */
export const MAX_IMPORT_JSON_BODY_BYTES = 64 * 1024 * 1024;

/**
 * **2ファイルを同時に受ける経路**（受付帳＋所有者の突合取込）の上限。
 * 各ファイルが 10MB まで許されるため、1ファイル分の上限では正規の取込を
 * 413 で弾いてしまう（Codex #349 P2）。1ファイル経路の 2 倍。
 */
export const MAX_IMPORT_JSON_BODY_BYTES_PAIRED =
  MAX_IMPORT_JSON_BODY_BYTES * 2;

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

/**
 * multipart/form-data の**パース前**サイズガード（@codex PR#414 2巡目 P1）。
 *
 * ⚠`request.formData()` は**ボディ全体をメモリに読み込む**。読み込んだ後で
 *   ファイルサイズを見ても、権限を持つ利用者が巨大なリクエストでメモリを
 *   食い潰せる。正しい形はリポジトリに既にある:
 *   `src/app/api/import/registry-pdf-bulk/route.ts` は Content-Length を
 *   `formData()` の**前**に見ている（OOM 対策と明記されている）。それと同じ形を
 *   1か所にまとめ、複数の route から同じ判定を通す。
 *
 * ⚠ヘッダ欠落・空・非数値（chunked 等でガードを回避しうる）は 411 で拒否する。
 *   ブラウザの fetch + FormData は必ず Content-Length を付けるため正規経路に影響なし。
 */

/** multipart の境界文字列・フィールド名などの上乗せ分（本文以外）。 */
export const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/**
 * @param maxFileBytes 本文（ファイル）として許す上限。上乗せ分はこの中で加算する。
 */
export function assertImportMultipartBodySize(
  request: { headers: { get(name: string): string | null } },
  maxFileBytes: number,
): void {
  const header = request.headers.get("content-length");
  const length = header === null ? NaN : Number(header.trim());
  if (
    header === null ||
    header.trim() === "" ||
    !Number.isFinite(length) ||
    length < 0
  ) {
    throw new ApiError(411, "Content-Length ヘッダが必要です", "LENGTH_REQUIRED");
  }
  if (length > maxFileBytes + MULTIPART_OVERHEAD_BYTES) {
    throw new ApiError(
      413,
      `送信データが上限(${maxFileBytes / 1024 / 1024}MB)を超えています`,
      "PAYLOAD_TOO_LARGE",
    );
  }
}
