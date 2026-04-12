/**
 * Local-disk storage adapter.
 *
 * Saves files under `public/uploads/` so Next.js can serve them
 * as static assets during development. In production this will be
 * replaced by a self-hosted server adapter.
 */

import fs from "fs/promises";
import path from "path";
import type { StorageAdapter, StorageUploadResult } from "./types";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

export class LocalStorageAdapter implements StorageAdapter {
  async upload(
    file: Buffer,
    options: { key: string; mimeType: string; fileName: string },
  ): Promise<StorageUploadResult> {
    const dest = path.join(UPLOAD_DIR, options.key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file);

    const url = `/uploads/${options.key.replace(/\\/g, "/")}`;
    return { url, key: options.key };
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(UPLOAD_DIR, key);
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async getUrl(key: string): Promise<string> {
    return `/uploads/${key.replace(/\\/g, "/")}`;
  }
}
