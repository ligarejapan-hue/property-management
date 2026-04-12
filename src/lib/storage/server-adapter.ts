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

import type { StorageAdapter, StorageUploadResult } from "./types";

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
}
