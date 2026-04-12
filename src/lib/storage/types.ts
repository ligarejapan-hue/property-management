/**
 * Storage adapter interface.
 *
 * All file storage goes through this abstraction so the backend
 * (local disk, self-hosted server, S3, GCS …) can be swapped by
 * changing a single env var.
 */

export interface StorageUploadResult {
  /** Publicly-reachable URL (or local path) for the stored file. */
  url: string;
  /** Thumbnail URL, if the adapter generated one. */
  thumbnailUrl?: string;
  /** Final key / path under which the file was stored. */
  key: string;
}

export interface StorageAdapter {
  /** Upload a file and return its URL + key. */
  upload(
    file: Buffer,
    options: {
      /** Destination path / key (e.g. "properties/abc/photo.jpg"). */
      key: string;
      mimeType: string;
      fileName: string;
    },
  ): Promise<StorageUploadResult>;

  /** Delete a file by its key. */
  delete(key: string): Promise<void>;

  /**
   * Return a (possibly pre-signed) download URL.
   * For public-read backends this can just return the stored url as-is.
   */
  getUrl(key: string): Promise<string>;
}

// ---------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------

/** Maximum upload size in bytes (8 MB). */
export const MAX_FILE_SIZE = 8 * 1024 * 1024;

/** MIME types allowed for photo uploads. */
export const ALLOWED_PHOTO_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** MIME types allowed for attachment (document) uploads. */
export const ALLOWED_ATTACHMENT_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * Validate file size and MIME type.
 * Returns an error message string, or null if valid.
 */
export function validateFile(
  fileSize: number,
  mimeType: string,
  allowedMimes: Set<string>,
): string | null {
  if (fileSize > MAX_FILE_SIZE) {
    return `ファイルサイズが上限 (${MAX_FILE_SIZE / 1024 / 1024}MB) を超えています`;
  }
  if (!allowedMimes.has(mimeType)) {
    return `許可されていないファイル形式です: ${mimeType}`;
  }
  return null;
}
