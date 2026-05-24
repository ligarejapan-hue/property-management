/**
 * Server Storage Adapter
 *
 * Implements StorageAdapter for a self-hosted file storage server.
 * Communicates with the storage server via HTTP API.
 *
 * Required env vars:
 *   STORAGE_SERVER_URL      - Base URL of the storage API (e.g. https://files.example.com)
 *   STORAGE_SERVER_API_KEY  - Auth key for the storage API
 *   STORAGE_SERVER_BUCKET   - Optional bucket / namespace (default: "property-management")
 */

import type {
  StorageAdapter,
  StorageReadResult,
  StorageUploadResult,
} from "./types";
import { DEFAULT_BINARY_MIME } from "./mime";
import { assertValidStorageKey, isValidStorageKey } from "./key-validation";

export class ServerStorageAdapter implements StorageAdapter {
  private serverUrl: string;
  private apiKey: string;
  private bucket: string;

  constructor() {
    this.serverUrl = (
      process.env.STORAGE_SERVER_URL ?? ""
    ).replace(/\/+$/, "");
    this.apiKey = process.env.STORAGE_SERVER_API_KEY ?? "";
    this.bucket = process.env.STORAGE_SERVER_BUCKET ?? "property-management";

    if (!this.serverUrl) {
      throw new Error(
        "STORAGE_SERVER_URL is not configured. Set it in .env to use server storage.",
      );
    }
    if (!this.apiKey) {
      throw new Error(
        "STORAGE_SERVER_API_KEY is not configured. Set it in .env to use server storage.",
      );
    }
  }

  async upload(
    file: Buffer,
    options: { key: string; mimeType: string; fileName: string },
  ): Promise<StorageUploadResult> {
    // Codex P1: backend に key を渡す前に必ず traversal validation。
    // encodeURIComponent("..") は ".." のままなので URL prefix の外へ抜ける
    // 可能性があり、入力時点で reject する必要がある。
    assertValidStorageKey(options.key);
    // Build multipart/form-data manually using the web FormData API
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([file as unknown as BlobPart], { type: options.mimeType }),
      options.fileName,
    );
    formData.append("key", options.key);
    formData.append("bucket", this.bucket);

    const res = await fetch(`${this.serverUrl}/upload`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new Error(
        `Storage upload failed (HTTP ${res.status}): ${errorText}`,
      );
    }

    const data = (await res.json()) as {
      url: string;
      thumbnailUrl?: string;
      key: string;
    };

    return {
      url: data.url,
      thumbnailUrl: data.thumbnailUrl,
      key: data.key,
    };
  }

  async delete(key: string): Promise<void> {
    // Codex P1: 不正な key は「既に存在しない」と同等に扱い、API を呼ばない
    // （他 adapter と整合: LocalStorageAdapter / S3Adapter も同方針）。
    if (!isValidStorageKey(key)) return;
    const res = await fetch(`${this.serverUrl}/delete`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key, bucket: this.bucket }),
    });

    // Ignore 404 (file already deleted)
    if (!res.ok && res.status !== 404) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new Error(
        `Storage delete failed (HTTP ${res.status}): ${errorText}`,
      );
    }
  }

  async getUrl(key: string): Promise<string> {
    // Codex P1: 同上 — URL 組み立て前に traversal を reject。
    assertValidStorageKey(key);
    // For public buckets: construct the URL directly
    // For private buckets: request a pre-signed URL from the server
    const res = await fetch(
      `${this.serverUrl}/url?key=${encodeURIComponent(key)}&bucket=${encodeURIComponent(this.bucket)}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      },
    );

    if (!res.ok) {
      // Fallback: construct URL directly
      return `${this.serverUrl}/${this.bucket}/${key}`;
    }

    const data = (await res.json()) as { url: string };
    return data.url;
  }

  /**
   * Phase 2: 実体取得。mock-storage-server.mjs の `GET /:bucket/:key` と整合。
   * - 404 → null
   * - 非 2xx → throw
   * - 2xx → Buffer + Content-Type ヘッダ
   *
   * Codex P1 (read 起因の指摘):
   *   旧実装は key を encodeURIComponent して URL 末尾に連結していたが、
   *   encodeURIComponent("..") は ".." のままなので server backend 側で
   *   path normalize されると "/{bucket}" prefix の外へ抜ける可能性があった。
   *   URL を組み立てる前に必ず traversal validation を行う。
   */
  async read(key: string): Promise<StorageReadResult | null> {
    assertValidStorageKey(key);
    const url = `${this.serverUrl}/${encodeURIComponent(this.bucket)}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new Error(
        `Storage read failed (HTTP ${res.status}): ${errorText}`,
      );
    }
    const arrayBuffer = await res.arrayBuffer();
    const body = Buffer.from(arrayBuffer);
    const contentType =
      res.headers.get("content-type") ?? DEFAULT_BINARY_MIME;
    return { body, contentType, size: body.length };
  }
}
