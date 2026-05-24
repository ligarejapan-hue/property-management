/**
 * Storage singleton.
 *
 * Returns the active StorageAdapter based on STORAGE_BACKEND env var.
 *
 * Supported values:
 *   "local"   – writes to public/uploads/ (default, dev)
 *   "server"  – self-hosted storage server
 *
 * To add a new backend:
 *   1. Create src/lib/storage/<name>-adapter.ts implementing StorageAdapter
 *   2. Add a case here
 *   3. Set STORAGE_BACKEND=<name> in .env
 */

import type { StorageAdapter } from "./types";
import { LocalStorageAdapter } from "./local-adapter";
import { ServerStorageAdapter } from "./server-adapter";
import { S3Adapter } from "./s3-adapter";

export type {
  StorageAdapter,
  StorageReadResult,
  StorageUploadResult,
} from "./types";
export {
  MAX_FILE_SIZE,
  ALLOWED_PHOTO_MIMES,
  ALLOWED_ATTACHMENT_MIMES,
  validateFile,
} from "./types";

let _instance: StorageAdapter | null = null;

/**
 * Storage singleton.
 *
 * Returns the active StorageAdapter based on STORAGE_BACKEND env var.
 *
 * Supported values:
 *   "local"   – writes to public/uploads/ (default, dev)
 *   "server"  – self-hosted storage server
 *   "s3"     – S3 互換 (AWS S3 / Cloudflare R2 / MinIO)。Phase 2 追加
 *
 * To add a new backend:
 *   1. Create src/lib/storage/<name>-adapter.ts implementing StorageAdapter
 *   2. Add a case here
 *   3. Set STORAGE_BACKEND=<name> in .env
 */
export function getStorage(): StorageAdapter {
  if (_instance) return _instance;

  const backend = process.env.STORAGE_BACKEND ?? "local";

  switch (backend) {
    case "local":
      _instance = new LocalStorageAdapter();
      break;
    case "server":
      _instance = new ServerStorageAdapter();
      break;
    case "s3":
      _instance = new S3Adapter();
      break;
    default:
      throw new Error(`Unknown STORAGE_BACKEND: ${backend}`);
  }

  return _instance;
}

/**
 * テスト専用: singleton をリセットする。
 * 通常のアプリ実行では呼ばない（呼ばれても安全だが意味がない）。
 */
export function __resetStorageForTest(): void {
  _instance = null;
}
