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

export type { StorageAdapter, StorageUploadResult } from "./types";
export {
  MAX_FILE_SIZE,
  ALLOWED_PHOTO_MIMES,
  ALLOWED_ATTACHMENT_MIMES,
  validateFile,
} from "./types";

let _instance: StorageAdapter | null = null;

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
    default:
      throw new Error(`Unknown STORAGE_BACKEND: ${backend}`);
  }

  return _instance;
}
