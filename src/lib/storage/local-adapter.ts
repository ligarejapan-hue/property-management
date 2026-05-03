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
import { resolveSafeUploadPath } from "./local-paths";

export class LocalStorageAdapter implements StorageAdapter {
  async upload(
    file: Buffer,
    options: { key: string; mimeType: string; fileName: string },
  ): Promise<StorageUploadResult> {
    // path traversal チェック付きで dest を解決（root 外への書き込みを防止）
    const dest = resolveSafeUploadPath(options.key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file);

    const url = `/uploads/${options.key.replace(/\\/g, "/")}`;
    return { url, key: options.key };
  }

  async delete(key: string): Promise<void> {
    let filePath: string;
    try {
      filePath = resolveSafeUploadPath(key);
    } catch {
      // 不正な key は「既に存在しない」と同等に扱う（ハードエラーにはしない）
      return;
    }
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
