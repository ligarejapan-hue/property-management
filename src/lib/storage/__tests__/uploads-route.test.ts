/**
 * /uploads/[...path] proxy route 統合テスト (Phase 2).
 *
 * 同一 URL `/uploads/<key>` が backend (Local / S3 mock) 切替で
 * 同じ bytes を返すこと、path traversal / 不存在 key の挙動が共通であることを担保する。
 *
 * 既存 DB の fileUrl は変えずに backend を切り替えられる、という Phase 2 の
 * 設計上の核心を route レベルで検証する位置づけ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { getApiSession, getUserPermissions, ApiError } from "@/lib/api-helpers";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";

vi.mock("@/lib/api-helpers", () => {
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    getApiSession: vi.fn().mockResolvedValue({
      id: "u1",
      email: "a@a",
      name: "A",
      role: "admin",
    }),
    getUserPermissions: vi.fn().mockResolvedValue([
      { resource: "property", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
    ]),
  };
});

// 既存テストは Phase A + storage 配信の整合確認が目的。Phase B 判定は別 unit test
// で担保するため、本 mock では既定で "ok" を返し、配信パスをそのまま通す。
vi.mock("@/lib/uploads-authorization", () => ({
  authorizeUploadAccess: vi.fn().mockResolvedValue("ok"),
}));

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

describe("Phase A: authentication", () => {
  beforeEach(() => {
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_UPLOAD_ROOT = tmpRoot;
    vi.mocked(getApiSession).mockResolvedValue({
      id: "u1",
      email: "a@a",
      name: "A",
      role: "admin",
    });
  });

  it("ApiError(401) は 401 を返す", async () => {
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await callGet(["properties", "abc", "photos", "x.png"]);
    expect(res.status).toBe(401);
  });

  it("通常 Error は 401 に変換せず rethrow する", async () => {
    vi.mocked(getApiSession).mockRejectedValueOnce(new Error("DB connection error"));
    await expect(
      callGet(["properties", "abc", "photos", "x.png"]),
    ).rejects.toThrow("DB connection error");
  });

  it("ApiError(500) は 401 に変換せず rethrow する", async () => {
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(500, "internal error", "INTERNAL_ERROR"),
    );
    await expect(
      callGet(["properties", "abc", "photos", "x.png"]),
    ).rejects.toThrow("internal error");
  });

  it("ログイン済みの場合は storage.read へ進み 200 を返す", async () => {
    const rel = "properties/abc/photos/auth.png";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await callGet(["properties", "abc", "photos", "auth.png"]);
    expect(res.status).toBe(200);
  });

  it("ログイン済み + path traversal は 403", async () => {
    const res = await callGet(["..", "etc", "passwd"]);
    expect(res.status).toBe(403);
  });

  it("ログイン済み + 不存在ファイルは 404", async () => {
    const res = await callGet(["missing", "auth-nofile.png"]);
    expect(res.status).toBe(404);
  });
});

describe("Phase B: authorization decision wiring", () => {
  beforeEach(() => {
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_UPLOAD_ROOT = tmpRoot;
    vi.mocked(getApiSession).mockResolvedValue({
      id: "u1",
      email: "a@a",
      name: "A",
      role: "admin",
    });
    vi.mocked(authorizeUploadAccess).mockResolvedValue("ok");
  });

  it("authorize が forbidden を返したら 403 で storage.read は呼ばない", async () => {
    vi.mocked(authorizeUploadAccess).mockResolvedValueOnce("forbidden");
    const res = await callGet(["properties", "p1", "photos", "x.png"]);
    expect(res.status).toBe(403);
  });

  it("authorize が not_found を返したら 404 で storage.read は呼ばない", async () => {
    vi.mocked(authorizeUploadAccess).mockResolvedValueOnce("not_found");
    const res = await callGet(["properties", "p1", "photos", "x.png"]);
    expect(res.status).toBe(404);
  });

  it("authorize が ok なら storage.read が呼ばれ 200", async () => {
    const rel = "properties/p1/photos/ok.png";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await callGet(["properties", "p1", "photos", "ok.png"]);
    expect(res.status).toBe(200);
  });
});

// stale session / user row deleted で getUserPermissions が ApiError(401) を
// 投げるケースは Phase A の auth error と同じく 401 に変換する。それ以外の
// ApiError / 通常 Error は 500 のまま rethrow される（401 へ潰さない）。
describe("Phase B: getUserPermissions auth error handling", () => {
  beforeEach(() => {
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_UPLOAD_ROOT = tmpRoot;
    vi.mocked(getApiSession).mockResolvedValue({
      id: "u1",
      email: "a@a",
      name: "A",
      role: "admin",
    });
    vi.mocked(authorizeUploadAccess).mockResolvedValue("ok");
  });

  it("getUserPermissions が ApiError(401) を投げたら 401", async () => {
    vi.mocked(getUserPermissions).mockRejectedValueOnce(
      new ApiError(401, "ユーザーが見つかりません", "UNAUTHORIZED"),
    );
    const res = await callGet(["properties", "p1", "photos", "x.png"]);
    expect(res.status).toBe(401);
  });

  it("getUserPermissions が ApiError(500) を投げたら 401 に変換せず rethrow", async () => {
    vi.mocked(getUserPermissions).mockRejectedValueOnce(
      new ApiError(500, "internal error", "INTERNAL_ERROR"),
    );
    await expect(
      callGet(["properties", "p1", "photos", "x.png"]),
    ).rejects.toThrow("internal error");
  });

  it("getUserPermissions が通常 Error を投げたら 401 に変換せず rethrow", async () => {
    vi.mocked(getUserPermissions).mockRejectedValueOnce(
      new Error("DB connection error"),
    );
    await expect(
      callGet(["properties", "p1", "photos", "x.png"]),
    ).rejects.toThrow("DB connection error");
  });
});
