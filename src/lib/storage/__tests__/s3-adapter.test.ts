/**
 * S3Adapter unit test (Phase 2).
 *
 * AWS SDK は aws-sdk-client-mock で全てモックする。実 S3 / R2 / MinIO は叩かない。
 * 重点:
 *   - upload 戻り値 URL が "/uploads/{key}" 形式（既存 DB レコード互換）
 *   - read で NoSuchKey / httpStatusCode 404 → null（throw しない）
 *   - read の Content-Type は ContentType ヘッダ優先、なければ
 *     application/octet-stream（拡張子フォールバックは Local 専用）
 *   - delete は NoSuchKey を握りつぶす
 *   - path traversal を含む key は upload / delete / read で reject
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import { S3Adapter } from "../s3-adapter";

const s3Mock = mockClient(S3Client);

const ORIGINAL_ENV = { ...process.env };

function setS3Env(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  process.env.STORAGE_S3_BUCKET = "test-bucket";
  process.env.STORAGE_S3_REGION = "auto";
  process.env.STORAGE_S3_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.STORAGE_S3_SECRET_ACCESS_KEY = "SECRET_TEST";
  delete process.env.STORAGE_S3_ENDPOINT;
  delete process.env.STORAGE_S3_FORCE_PATH_STYLE;
  Object.assign(process.env, overrides);
}

function makeStreamLike(bytes: Uint8Array) {
  return {
    transformToByteArray: async () => bytes,
  };
}

beforeEach(() => {
  s3Mock.reset();
  setS3Env();
});

afterEach(() => {
  // env 復旧（他テストへの汚染回避）
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("STORAGE_S3_")) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("S3Adapter constructor", () => {
  it("必須 env が未設定なら throw する", () => {
    delete process.env.STORAGE_S3_BUCKET;
    expect(() => new S3Adapter()).toThrow(/STORAGE_S3_BUCKET/);
  });

  it("REGION / ACCESS_KEY_ID / SECRET も必須", () => {
    delete process.env.STORAGE_S3_REGION;
    expect(() => new S3Adapter()).toThrow(/STORAGE_S3_REGION/);
    setS3Env();
    delete process.env.STORAGE_S3_ACCESS_KEY_ID;
    expect(() => new S3Adapter()).toThrow(/STORAGE_S3_ACCESS_KEY_ID/);
    setS3Env();
    delete process.env.STORAGE_S3_SECRET_ACCESS_KEY;
    expect(() => new S3Adapter()).toThrow(/STORAGE_S3_SECRET_ACCESS_KEY/);
  });

  it("ENDPOINT 設定で R2 / MinIO 接続を許容（throw しない）", () => {
    setS3Env({
      STORAGE_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      STORAGE_S3_FORCE_PATH_STYLE: "true",
    });
    expect(() => new S3Adapter()).not.toThrow();
  });
});

describe("S3Adapter.upload", () => {
  it("PutObjectCommand を bucket/key/ContentType 付きで送り、URL は /uploads/{key} を返す", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const adapter = new S3Adapter();
    const result = await adapter.upload(Buffer.from([1, 2, 3]), {
      key: "properties/abc/photos/1.jpg",
      mimeType: "image/jpeg",
      fileName: "1.jpg",
    });
    expect(result.url).toBe("/uploads/properties/abc/photos/1.jpg");
    expect(result.key).toBe("properties/abc/photos/1.jpg");

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("properties/abc/photos/1.jpg");
    expect(input.ContentType).toBe("image/jpeg");
  });

  it("path traversal を含む key は reject (S3 にも送らない)", async () => {
    const adapter = new S3Adapter();
    await expect(
      adapter.upload(Buffer.alloc(1), {
        key: "../etc/passwd",
        mimeType: "text/plain",
        fileName: "x",
      }),
    ).rejects.toThrow(/path traversal/);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it("空 key / . / 絶対パス key も reject", async () => {
    const adapter = new S3Adapter();
    for (const bad of ["", ".", "/abs/path", "a//b"]) {
      await expect(
        adapter.upload(Buffer.alloc(1), {
          key: bad,
          mimeType: "text/plain",
          fileName: "x",
        }),
      ).rejects.toThrow(/path traversal/);
    }
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});

describe("S3Adapter.read", () => {
  it("成功時は Buffer + Content-Type + size を返す", async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeStreamLike(bytes) as unknown as GetObjectCommandOutput["Body"],
      ContentType: "image/png",
      ContentLength: bytes.length,
    });
    const adapter = new S3Adapter();
    const result = await adapter.read("properties/x/photos/y.png");
    expect(result).not.toBeNull();
    expect(result!.body.equals(Buffer.from(bytes))).toBe(true);
    expect(result!.contentType).toBe("image/png");
    expect(result!.size).toBe(bytes.length);
  });

  it("ContentType が無い場合は application/octet-stream にフォールバック", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeStreamLike(new Uint8Array([1])) as unknown as GetObjectCommandOutput["Body"],
      // ContentType 未指定
    });
    const adapter = new S3Adapter();
    const result = await adapter.read("a/b");
    expect(result!.contentType).toBe("application/octet-stream");
  });

  it("NoSuchKey 例外 → null（throw しない）", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "nope" }),
    );
    const adapter = new S3Adapter();
    const result = await adapter.read("missing/x");
    expect(result).toBeNull();
  });

  it("httpStatusCode 404 (NoSuchKey 以外の互換 backend) → null", async () => {
    // R2 / MinIO 等は NoSuchKey ではなく一般 Error + $metadata.httpStatusCode=404 を返す場合がある
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("Not Found"), {
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const adapter = new S3Adapter();
    const result = await adapter.read("missing/y");
    expect(result).toBeNull();
  });

  it("path traversal key は reject (S3 にも送らない)", async () => {
    const adapter = new S3Adapter();
    await expect(adapter.read("../etc/passwd")).rejects.toThrow(/path traversal/);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("500 等の非 404 エラーは throw する", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("Internal"), {
        $metadata: { httpStatusCode: 500 },
      }),
    );
    const adapter = new S3Adapter();
    await expect(adapter.read("a/b")).rejects.toThrow(/Internal/);
  });
});

describe("S3Adapter.delete", () => {
  it("正常系: DeleteObjectCommand を送る", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const adapter = new S3Adapter();
    await adapter.delete("properties/a/photos/b.jpg");
    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Bucket).toBe("test-bucket");
    expect(calls[0].args[0].input.Key).toBe("properties/a/photos/b.jpg");
  });

  it("NoSuchKey は握りつぶす", async () => {
    s3Mock.on(DeleteObjectCommand).rejects(
      new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "gone" }),
    );
    const adapter = new S3Adapter();
    await expect(adapter.delete("missing/x")).resolves.toBeUndefined();
  });

  it("invalid key は早期 return（S3 にも送らない、throw しない）", async () => {
    const adapter = new S3Adapter();
    await adapter.delete("../etc/passwd");
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});

describe("S3Adapter.getUrl", () => {
  it("signed URL は返さず /uploads/{key} を返す (Phase 2: proxy 配信前提)", async () => {
    const adapter = new S3Adapter();
    const url = await adapter.getUrl("properties/a/photos/b.jpg");
    expect(url).toBe("/uploads/properties/a/photos/b.jpg");
  });
});

describe("S3Adapter.keyFromUrl", () => {
  it("相対 /uploads/{key} → key 抽出", () => {
    const adapter = new S3Adapter();
    expect(adapter.keyFromUrl("/uploads/a/b.jpg")).toBe("a/b.jpg");
  });

  it("絶対 URL の /uploads/{key} → key 抽出", () => {
    const adapter = new S3Adapter();
    expect(adapter.keyFromUrl("http://localhost:3000/uploads/a/b.jpg")).toBe("a/b.jpg");
  });

  it("/api/x など /uploads/ でない → null", () => {
    const adapter = new S3Adapter();
    expect(adapter.keyFromUrl("/api/x")).toBeNull();
  });

  it("data: → null", () => {
    const adapter = new S3Adapter();
    expect(adapter.keyFromUrl("data:application/pdf;base64,AAAA")).toBeNull();
  });

  it("null → null", () => {
    const adapter = new S3Adapter();
    expect(adapter.keyFromUrl(null)).toBeNull();
  });
});
