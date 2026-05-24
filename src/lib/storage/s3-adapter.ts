/**
 * S3 互換 Storage Adapter (Phase 2).
 *
 * AWS S3 / Cloudflare R2 / MinIO の 3 backend に共通対応する S3 互換アダプタ。
 * adapter 名と STORAGE_BACKEND 値は "s3" のまま、`endpoint` /
 * `forcePathStyle` の env 切替で R2 / MinIO にも接続できる。
 *
 * 必須 env:
 *   STORAGE_S3_BUCKET
 *   STORAGE_S3_REGION              (R2 は "auto", AWS は ap-northeast-1 等)
 *   STORAGE_S3_ACCESS_KEY_ID
 *   STORAGE_S3_SECRET_ACCESS_KEY
 *
 * 任意 env:
 *   STORAGE_S3_ENDPOINT            R2 / MinIO のときに設定
 *   STORAGE_S3_FORCE_PATH_STYLE    MinIO 等で true / 既定 false
 *
 * 戻り値方針 (URL 互換):
 *   upload().url     → "/uploads/{key}"  ← 既存 DB レコード形式と一致
 *   getUrl(key)      → "/uploads/{key}"  ← 同上 (signed URL は Phase 2 非対応)
 *   実体配信は /uploads/[...path] route が read(key) を呼んで行う
 *
 * Phase 2 範囲外:
 *   - signed URL 生成
 *   - thumbnail 生成 (upload 戻りに thumbnailUrl 含めない)
 *   - delete 時に他 backend で実体が残るかどうかの整合 (呼び出し側責務)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import type {
  StorageAdapter,
  StorageReadResult,
  StorageUploadResult,
} from "./types";
import { DEFAULT_BINARY_MIME } from "./mime";

function isValidStorageKey(key: string): boolean {
  if (key === "" || key === "." || key === "..") return false;
  const normalized = key.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  // 連続スラッシュ / . / .. のいずれかの segment が含まれる key を拒否
  for (const seg of normalized.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`${name} is not configured. Set it in .env to use s3 storage.`);
  }
  return v;
}

export class S3Adapter implements StorageAdapter {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = requireEnv("STORAGE_S3_BUCKET");
    const region = requireEnv("STORAGE_S3_REGION");
    const accessKeyId = requireEnv("STORAGE_S3_ACCESS_KEY_ID");
    const secretAccessKey = requireEnv("STORAGE_S3_SECRET_ACCESS_KEY");
    const endpoint = process.env.STORAGE_S3_ENDPOINT?.trim() || undefined;
    const forcePathStyle =
      (process.env.STORAGE_S3_FORCE_PATH_STYLE ?? "false")
        .trim()
        .toLowerCase() === "true";

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async upload(
    file: Buffer,
    options: { key: string; mimeType: string; fileName: string },
  ): Promise<StorageUploadResult> {
    if (!isValidStorageKey(options.key)) {
      throw new Error(
        `Invalid storage key (path traversal blocked): ${options.key}`,
      );
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: options.key,
        Body: file,
        ContentType: options.mimeType,
      }),
    );
    // URL 互換: 既存 DB の fileUrl 形式 (/uploads/{key}) を維持。
    // 実体配信は /uploads/[...path] proxy が read() 経由で返す。
    return {
      url: `/uploads/${options.key.replace(/\\/g, "/")}`,
      key: options.key,
    };
  }

  async delete(key: string): Promise<void> {
    if (!isValidStorageKey(key)) {
      // 不正な key は「既に存在しない」と同等に扱う（他 adapter と整合）
      return;
    }
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (err instanceof NoSuchKey) return;
      // S3 仕様上 delete は 204 / 404 共に成功扱いだが、念のため NoSuchKey のみ握りつぶす
      throw err;
    }
  }

  async getUrl(key: string): Promise<string> {
    // signed URL は Phase 2 非対応。proxy 配信前提で /uploads/{key} を返す。
    return `/uploads/${key.replace(/\\/g, "/")}`;
  }

  async read(key: string): Promise<StorageReadResult | null> {
    if (!isValidStorageKey(key)) {
      throw new Error(`Invalid storage key (path traversal blocked): ${key}`);
    }
    let res;
    try {
      res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      // S3 互換 backend によっては 404 が NoSuchKey ではなく
      // metadata.httpStatusCode 経由で来るので両方扱う
      if (
        typeof err === "object" &&
        err !== null &&
        "$metadata" in err &&
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }

    const stream = res.Body as
      | undefined
      | { transformToByteArray?: () => Promise<Uint8Array> };
    if (!stream || typeof stream.transformToByteArray !== "function") {
      throw new Error("S3 GetObject returned unexpected body");
    }
    const bytes = await stream.transformToByteArray();
    const body = Buffer.from(bytes);
    const contentType =
      res.ContentType && res.ContentType.trim() !== ""
        ? res.ContentType
        : DEFAULT_BINARY_MIME;
    const size =
      typeof res.ContentLength === "number" ? res.ContentLength : body.length;
    return { body, contentType, size };
  }
}
