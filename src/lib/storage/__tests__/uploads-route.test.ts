/**
 * /uploads/[...path] proxy route 統合テスト (Phase 2).
 *
 * 同一 URL `/uploads/<key>` が backend (Local / S3 mock) 切替で
 * 同じ bytes を返すこと、path traversal / 不存在 key の挙動が共通であることを担保する。
 *
 * 既存 DB の fileUrl は変えずに backend を切り替えられる、という Phase 2 の
 * 設計上の核心を route レベルで検証する位置づけ。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  GetObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";

import { __resetStorageForTest } from "@/lib/storage";
import { GET } from "@/app/uploads/[...path]/route";

const s3Mock = mockClient(S3Client);
const ORIGINAL_ENV = { ...process.env };

let tmpRoot: string;

function makeStreamLike(bytes: Uint8Array) {
  return { transformToByteArray: async () => bytes };
}

// Next.js 16 の (req, ctx) 形式に合わせた呼び出し helper。
async function callGet(parts: string[]) {
  const url = `http://localhost/uploads/${parts.join("/")}`;
  const req = new Request(url) as unknown as Parameters<typeof GET>[0];
  return GET(req, {
    params: Promise.resolve({ path: parts }),
  });
}

beforeEach(async () => {
  s3Mock.reset();
  __resetStorageForTest();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uploads-route-test-"));
  // 既存テストとの env 汚染回避: storage 関連 env を一旦全クリア
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("STORAGE_") || k === "LOCAL_UPLOAD_ROOT") {
      delete process.env[k];
    }
  }
});

afterEach(async () => {
  __resetStorageForTest();
  // tmpRoot を片付ける
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("STORAGE_") || k === "LOCAL_UPLOAD_ROOT") {
      delete process.env[k];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("/uploads/[...path] with LocalStorageAdapter", () => {
  beforeEach(() => {
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_UPLOAD_ROOT = tmpRoot;
  });

  it("既存ファイルを bytes + Content-Type 付きで返す", async () => {
    const rel = "properties/abc/photos/x.png";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await fs.writeFile(abs, bytes);

    const res = await callGet(["properties", "abc", "photos", "x.png"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    const arr = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(arr).equals(bytes)).toBe(true);
  });

  it("不存在ファイルは 404", async () => {
    const res = await callGet(["missing", "file.png"]);
    expect(res.status).toBe(404);
  });

  it("path traversal (..) は 403", async () => {
    const res = await callGet(["..", "etc", "passwd"]);
    expect(res.status).toBe(403);
  });

  it("空 path は 404", async () => {
    const res = await callGet([]);
    expect(res.status).toBe(404);
  });

  it("拡張子から Content-Type を推定（pdf）", async () => {
    const rel = "doc.pdf";
    await fs.writeFile(path.join(tmpRoot, rel), Buffer.from("%PDF-"));
    const res = await callGet(["doc.pdf"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });
});

describe("/uploads/[...path] with S3Adapter (mocked)", () => {
  beforeEach(() => {
    process.env.STORAGE_BACKEND = "s3";
    process.env.STORAGE_S3_BUCKET = "test-bucket";
    process.env.STORAGE_S3_REGION = "auto";
    process.env.STORAGE_S3_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.STORAGE_S3_SECRET_ACCESS_KEY = "SECRET_TEST";
  });

  it("同じ URL で S3 から bytes が返る (URL 互換)", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeStreamLike(bytes) as never,
      ContentType: "image/jpeg",
      ContentLength: bytes.length,
    });
    const res = await callGet(["properties", "abc", "photos", "x.jpg"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    const arr = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(arr).equals(Buffer.from(bytes))).toBe(true);
    // S3 へ送ったコマンドが期待 key で組まれている
    const calls = s3Mock.commandCalls(GetObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toBe("properties/abc/photos/x.jpg");
  });

  it("S3 NoSuchKey は 404 に変換される", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "nope" }),
    );
    const res = await callGet(["missing", "x.png"]);
    expect(res.status).toBe(404);
  });

  it("S3 backend でも path traversal (..) は 403 (adapter で reject)", async () => {
    const res = await callGet(["..", "etc", "passwd"]);
    expect(res.status).toBe(403);
    // S3 にコマンドを送っていない
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });
});
