/**
 * Storage 共通の MIME マップ。
 *
 * /uploads/[...path] route handler / LocalStorageAdapter.read / S3 fallback で
 * 同じ拡張子→Content-Type 変換を使うために集中管理する。
 *
 * Phase 2: upload 時に受け取った mimeType を実体に保存する backend (S3 / Server)
 * では `Content-Type` ヘッダを優先し、本マップは Local 等の「実体に MIME を
 * 保存しない backend」での fallback として使う。
 */

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

export const DEFAULT_BINARY_MIME = "application/octet-stream";

/**
 * 拡張子から Content-Type を推定する。
 * - 大文字小文字を吸収する
 * - 未知の拡張子 / 拡張子なし → application/octet-stream
 */
export function getMimeFromExtension(filenameOrKey: string): string {
  const lastDot = filenameOrKey.lastIndexOf(".");
  if (lastDot < 0) return DEFAULT_BINARY_MIME;
  const ext = filenameOrKey.slice(lastDot).toLowerCase();
  return MIME[ext] ?? DEFAULT_BINARY_MIME;
}
