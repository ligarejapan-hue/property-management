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
import {
  authorizeUploadAccess,
  resolveProtectedServeMeta,
} from "@/lib/uploads-authorization";
import { buildUploadsEtag } from "@/lib/uploads-etag";
import { writeAuditLog } from "@/lib/audit";
import { registryContentDisposition } from "@/lib/attachments/registry-display-name";
import { referralContentDisposition } from "@/lib/attachments/referral-display-name";

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
  // S1b-4 / 24巡目: 既存 route テストは**保護対象でない**配信の整合確認が目的。
  // メタは null（= 写真・一般添付）を返し、従来ヘッダ・挙動のまま通す。
  resolveProtectedServeMeta: vi.fn().mockResolvedValue(null),
}));

// registry 配信の監査呼び出しを runtime で検証するため mock する。
// （実体 writeAuditLog は内部 try/catch の fail-open。route は registryMeta が
//   null の既存テストでは一切呼ばない）
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

const s3Mock = mockClient(S3Client);
const ORIGINAL_ENV = { ...process.env };

let tmpRoot: string;

function makeStreamLike(bytes: Uint8Array) {
  return { transformToByteArray: async () => bytes };
}

// Next.js 16 の (req, ctx) 形式に合わせた呼び出し helper。
// query（?download=1 等）/ headers（Range 等）は省略時従来通り。
async function callGet(
  parts: string[],
  opts: { query?: string; headers?: Record<string, string> } = {},
) {
  const url = `http://localhost/uploads/${parts.join("/")}${opts.query ?? ""}`;
  const req = new Request(url, {
    headers: opts.headers,
  }) as unknown as Parameters<typeof GET>[0];
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
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
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

// ============================================================
// F11 uploads配信 現状ロック（17-A・test-only guard）
//  (1) S1b-4 registry 配信ヘッダ/監査の runtime 検証
//      （従来は registry-pdf-enforcement.test.ts の source-assertion のみで、
//        実 Response のヘッダ・writeAuditLog 呼び出しは未検証だった盲点を閉じる）
//  (2) Range request 非対応の現状固定（常に 200 全量・206/Accept-Ranges 無し）
//      → 将来 Range 対応する際はこのロックを意図的に更新する
//  (3) MIME 未知拡張子（.svg 等の危険型含む）は application/octet-stream に
//      フォールバックする安全挙動の固定（Local backend）
//  (4) 未デコード "%2e%2e" セグメントはリテラル名として扱われ traversal しない
//      （key-validation.ts の「Next.js が decode 済みで渡す」前提の境界ロック）
// production code は不変。route/lib/headers の現状仕様をロックするのみ。
// ============================================================
describe("F11: registry 配信ヘッダ/監査 + 配信現状ロック", () => {
  const REGISTRY_META = {
    kind: "registry" as const,
    isRegistry: true as const,
    attachmentId: "att-1",
    propertyId: "prop-1",
    // 保存名の材料（非PII）。JST 2026-08-25 12:00。
    certificateType: "owner" as string | null,
    createdAt: new Date("2026-08-25T03:00:00.000Z") as Date | null,
  };

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
    vi.mocked(resolveProtectedServeMeta).mockResolvedValue(null);
    vi.mocked(writeAuditLog).mockClear();
  });

  async function writeRegistryPdf() {
    const rel = "properties/p1/registry/100.pdf";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from("%PDF-1.4 test"));
    return ["properties", "p1", "registry", "100.pdf"];
  }

  it("registry preview: no-store / nosniff / inline / 監査 registry_pdf_preview（runtime）", async () => {
    const parts = await writeRegistryPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REGISTRY_META);

    const res = await callGet(parts);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(audit.action).toBe("registry_pdf_preview");
    expect(audit.targetTable).toBe("attachments");
    expect(audit.targetId).toBe("att-1");
    expect(audit.detail).toEqual({ propertyId: "prop-1" });
    // 元ファイル名（PII の恐れ）が監査 detail に乗らない
    expect(JSON.stringify(audit.detail)).not.toContain("fileName");
  });

  it("registry download (?download=1): 種別＋登録日の保存名 / ASCII フォールバック維持 / 監査 registry_pdf_download", async () => {
    const parts = await writeRegistryPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REGISTRY_META);

    const res = await callGet(parts, { query: "?download=1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // 手元に落ちる名前を決めるのはこのヘッダ。共通関数と同じ値であることを固定する。
    expect(res.headers.get("Content-Disposition")).toBe(
      registryContentDisposition({
        downloadIntent: true,
        certType: "owner",
        createdAt: new Date("2026-08-25T03:00:00.000Z"),
      }),
    );
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="registry.pdf"',
    );
    const ext = (res.headers.get("Content-Disposition") ?? "").split(
      "filename*=UTF-8''",
    )[1];
    expect(decodeURIComponent(ext)).toBe("謄本(所有者事項)_2026-08-25.pdf");

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(audit.action).toBe("registry_pdf_download");
  });

  it("registry download: 種別が記録されていない謄本でも、元ファイル名は保存名に出さない", async () => {
    const parts = await writeRegistryPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce({
      ...REGISTRY_META,
      certificateType: null,
    });

    const res = await callGet(parts, { query: "?download=1" });
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const ext = disposition.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(ext)).toBe("謄本_2026-08-25.pdf");
    // ヘッダは ASCII のみ（生の日本語・改行を混ぜないことを、符号で直接確かめる）。
    const codes = [...disposition].map((c) => c.charCodeAt(0));
    expect(codes.includes(13)).toBe(false);
    expect(codes.includes(10)).toBe(false);
    expect(codes.every((c) => c >= 0x20 && c <= 0x7e)).toBe(true);
  });

  it("registry: propertyId が null の場合 detail は undefined（非 PII 維持）", async () => {
    const parts = await writeRegistryPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce({
      ...REGISTRY_META,
      propertyId: null,
    });

    const res = await callGet(parts);
    expect(res.status).toBe(200);
    const audit = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(audit.detail).toBeUndefined();
  });

  it("非 registry 配信は監査を書かない（registryMeta null）", async () => {
    const rel = "properties/p1/photos/plain.png";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const res = await callGet(["properties", "p1", "photos", "plain.png"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    // 非 registry には nosniff / Content-Disposition を付けない（現状仕様）
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("Range ヘッダは無視され 200 全量を返す（206/Accept-Ranges/Content-Range なし＝現状固定）", async () => {
    const rel = "properties/p1/photos/range.png";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await fs.writeFile(abs, bytes);

    const res = await callGet(["properties", "p1", "photos", "range.png"], {
      headers: { Range: "bytes=0-2" },
    });
    // 現状は Range 非対応: 部分応答にせず常に全量 200。
    // 将来 Range/206 対応を入れる場合はこのテストを意図的に更新すること。
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBeNull();
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    const arr = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(arr).equals(bytes)).toBe(true);
  });

  it("MIME map 外拡張子（.svg）は application/octet-stream（inline 実行されない安全側）", async () => {
    const rel = "properties/p1/attachments/evil.svg";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from("<svg onload=alert(1)/>"));

    const res = await callGet(["properties", "p1", "attachments", "evil.svg"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("未デコード '%2e%2e' セグメントはリテラル名扱いで traversal しない（404）", async () => {
    // Next.js は通常 decode 済み params を渡す（key-validation.ts の前提）。
    // 仮に未デコード文字列が届いても '..' にならずリテラルなディレクトリ名として
    // 解決され、root 外へ出ない（存在しないため 404）ことを境界ロックする。
    const res = await callGet(["%2e%2e", "etc", "passwd"]);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// ETag / If-None-Match → 304（F11 Phase 1・非 registry 条件付き GET）
//  - ETag は immutable な storage key 由来（uploads-etag.ts）。adapter 変更なし。
//  - 304 は認可（session / permissions / authorizeUploadAccess）通過後にのみ返す。
//    認可前 304 は禁止（401/403/404 が常に優先される）。
//  - registry PDF は S1b-4 の no-store + 毎配信監査を維持するため 304 対象外。
//  - 304 は storage 実体の存在確認（read 成功）後にのみ返す。実体欠落は
//    If-None-Match 一致（`*` 含む）でも 404 のまま（304 で欠落を隠さない）。
//    Phase 1 は安全性優先で read 後判定のため fetch は走り、本文転送のみスキップ。
//  - Range は引き続き非対応（既存の現状固定テストを維持・併送時も挙動不変）。
// ============================================================
describe("ETag/304: 非 registry の条件付き GET", () => {
  const REGISTRY_META = {
    kind: "registry" as const,
    isRegistry: true as const,
    attachmentId: "att-1",
    propertyId: "prop-1",
    // 保存名の材料（非PII）。JST 2026-08-25 12:00。
    certificateType: "owner" as string | null,
    createdAt: new Date("2026-08-25T03:00:00.000Z") as Date | null,
  };

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
    vi.mocked(authorizeUploadAccess).mockClear();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValue(null);
    vi.mocked(writeAuditLog).mockClear();
  });

  async function writePhoto(rel: string, bytes: Buffer) {
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }

  it("非 registry の 200 に key 由来の決定的 ETag が付く", async () => {
    const rel = "properties/p1/photos/etag.png";
    await writePhoto(rel, Buffer.from([1, 2, 3]));

    const res1 = await callGet(["properties", "p1", "photos", "etag.png"]);
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("ETag");
    expect(etag).toBe(buildUploadsEtag(rel));
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    // 同一 key の再取得でも同一 ETag（決定的）
    const res2 = await callGet(["properties", "p1", "photos", "etag.png"]);
    expect(res2.headers.get("ETag")).toBe(etag);
    // Cache-Control は従来のまま（public 化しない）
    expect(res1.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("If-None-Match 一致 → 認可+実体確認の後に 304・本文なし・ETag/Cache-Control 付き", async () => {
    const rel = "properties/p1/photos/cached.png";
    await writePhoto(rel, Buffer.from([1, 2, 3]));
    const etag = buildUploadsEtag(rel);
    const res = await callGet(["properties", "p1", "photos", "cached.png"], {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe(""); // 本文なし（転送スキップ）
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    // 304 でも認可は必ず通っている（認可前 304 禁止）
    expect(authorizeUploadAccess).toHaveBeenCalledTimes(1);
  });

  it("storage 実体が欠落していれば If-None-Match 一致でも 404（304 で欠落を隠さない）", async () => {
    const rel = "properties/p1/photos/missing.png";
    // 実体ファイルを意図的に作らない
    const res = await callGet(["properties", "p1", "photos", "missing.png"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(404);
  });

  it("If-None-Match: * は実体ありなら 304・欠落なら 404", async () => {
    // 欠落 → 404（* でも 304 にしない）
    const resMissing = await callGet(
      ["properties", "p1", "photos", "star-missing.png"],
      { headers: { "If-None-Match": "*" } },
    );
    expect(resMissing.status).toBe(404);

    // 実体あり → 304
    await writePhoto("properties/p1/photos/star.png", Buffer.from([1]));
    const resHit = await callGet(["properties", "p1", "photos", "star.png"], {
      headers: { "If-None-Match": "*" },
    });
    expect(resHit.status).toBe(304);
  });

  it("304 時も storage 実体の存在確認は行う（S3: GetObject 1 回・本文は返さない）", async () => {
    // Phase 1 は安全性優先で read 後に 304 判定（fetch 回避は exists/metadata 導入後の次PR候補）。
    process.env.STORAGE_BACKEND = "s3";
    process.env.STORAGE_S3_BUCKET = "test-bucket";
    process.env.STORAGE_S3_REGION = "auto";
    process.env.STORAGE_S3_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.STORAGE_S3_SECRET_ACCESS_KEY = "SECRET_TEST";
    __resetStorageForTest();

    const bytes = new Uint8Array([10, 20, 30]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeStreamLike(bytes) as never,
      ContentType: "image/jpeg",
      ContentLength: bytes.length,
    });

    const rel = "properties/p1/photos/s3cached.jpg";
    const res = await callGet(["properties", "p1", "photos", "s3cached.jpg"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe(""); // 実体確認はするが本文は転送しない
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  it("S3 で実体欠落（NoSuchKey）なら If-None-Match 一致でも 404", async () => {
    process.env.STORAGE_BACKEND = "s3";
    process.env.STORAGE_S3_BUCKET = "test-bucket";
    process.env.STORAGE_S3_REGION = "auto";
    process.env.STORAGE_S3_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.STORAGE_S3_SECRET_ACCESS_KEY = "SECRET_TEST";
    __resetStorageForTest();

    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "nope" }),
    );

    const rel = "properties/p1/photos/s3gone.jpg";
    const res = await callGet(["properties", "p1", "photos", "s3gone.jpg"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(404);
  });

  it("If-None-Match 不一致 → 従来通り 200 全量 + ETag", async () => {
    const rel = "properties/p1/photos/miss.png";
    const bytes = Buffer.from([9, 8, 7, 6]);
    await writePhoto(rel, bytes);

    const res = await callGet(["properties", "p1", "photos", "miss.png"], {
      headers: { "If-None-Match": '"deadbeefdeadbeefdeadbeefdeadbeef"' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(buildUploadsEtag(rel));
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    const arr = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(arr).equals(bytes)).toBe(true);
  });

  it("W/ 付き・カンマ区切りリストの If-None-Match でも一致すれば 304（weak comparison）", async () => {
    const rel = "properties/p1/photos/weak.png";
    await writePhoto(rel, Buffer.from([1]));
    const etag = buildUploadsEtag(rel);
    const res = await callGet(["properties", "p1", "photos", "weak.png"], {
      headers: { "If-None-Match": `"deadbeef", W/${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("registry PDF は 304 対象外: If-None-Match 一致相当でも 200 全量 + no-store + 監査（ETag なし）", async () => {
    const rel = "properties/p1/registry/200.pdf";
    await writePhoto(rel, Buffer.from("%PDF-1.4 regi"));
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REGISTRY_META);

    // 仮に client が key 由来 ETag を偽装して送っても registry は常に全量配信+監査
    const res = await callGet(["properties", "p1", "registry", "200.pdf"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBeNull(); // registry に ETag を発行しない
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(await res.text()).toContain("%PDF");
    // 304 で監査がスキップされない（毎配信監査の維持）
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAuditLog).mock.calls[0][0].action).toBe(
      "registry_pdf_preview",
    );
  });

  it("registry download (?download=1) + If-None-Match でも no-store / attachment 維持", async () => {
    const rel = "properties/p1/registry/201.pdf";
    await writePhoto(rel, Buffer.from("%PDF-1.4 dl"));
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REGISTRY_META);

    const res = await callGet(["properties", "p1", "registry", "201.pdf"], {
      query: "?download=1",
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // ここが見張るのは「添付として落ちること」。保存名そのものは共通関数側で固定する。
    expect(res.headers.get("Content-Disposition")).toContain(
      'attachment; filename="registry.pdf"',
    );
    expect(vi.mocked(writeAuditLog).mock.calls[0][0].action).toBe(
      "registry_pdf_download",
    );
  });

  it("未認証は If-None-Match があっても 401（304 にしない）", async () => {
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const rel = "properties/p1/photos/auth.png";
    const res = await callGet(["properties", "p1", "photos", "auth.png"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(401);
  });

  it("authorize forbidden は If-None-Match があっても 403（304 にしない）", async () => {
    vi.mocked(authorizeUploadAccess).mockResolvedValueOnce("forbidden");
    const rel = "properties/p1/photos/forbidden.png";
    const res = await callGet(["properties", "p1", "photos", "forbidden.png"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(403);
  });

  it("authorize not_found は If-None-Match があっても 404（304 にしない）", async () => {
    vi.mocked(authorizeUploadAccess).mockResolvedValueOnce("not_found");
    const rel = "properties/p1/photos/gone.png";
    const res = await callGet(["properties", "p1", "photos", "gone.png"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(404);
  });

  it("Range + If-None-Match 一致の併送 → 304（Range は引き続き無視・206 にしない）", async () => {
    const rel = "properties/p1/photos/range304.png";
    await writePhoto(rel, Buffer.from([1, 2, 3, 4]));
    const res = await callGet(["properties", "p1", "photos", "range304.png"], {
      headers: {
        Range: "bytes=0-2",
        "If-None-Match": buildUploadsEtag(rel),
      },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("Accept-Ranges")).toBeNull();
    expect(res.headers.get("Content-Range")).toBeNull();
  });
});

// ============================================================
// 19-A: VPS 無認証外形チェック期待値ロック（test-only guard）
//  本番 VPS（08af869）への無認証 curl で確認した外形挙動を回帰防止として固定する。
//  (1) 401 応答のヘッダ衛生: 無認証 401 に ETag / Cache-Control を載せない
//      （実機確認: 401 応答ヘッダに ETag / Cache-Control なし。キャッシュ層や
//        client に認可前のキャッシュ手がかりを一切与えない）
//  (2) 無認証 + If-None-Match（一致偽装・`*`）でも常に 401（認可前 304 禁止の
//      ヘッダ衛生込み再固定。status のみの既存ロックを補完する）
//  (3) 無認証の registry パスは 401 で、registry 解決・認可・監査・registry
//      配信ヘッダ（no-store/nosniff/Content-Disposition）のいずれも発生しない
//      （auth が全段より先に走る順序のロック）
//  (4) registry preview / download は If-None-Match の有無に関わらず ETag を
//      発行しない（既存ロックは If-None-Match 併送時のみだった盲点を閉じる）
// production code は不変。route の現状仕様をロックするのみ。
// ============================================================
describe("19-A: 無認証 401 ヘッダ衛生 + registry ETag 不発行ロック", () => {
  const REGISTRY_META = {
    kind: "registry" as const,
    isRegistry: true as const,
    attachmentId: "att-1",
    propertyId: "prop-1",
    // 保存名の材料（非PII）。JST 2026-08-25 12:00。
    certificateType: "owner" as string | null,
    createdAt: new Date("2026-08-25T03:00:00.000Z") as Date | null,
  };

  beforeEach(() => {
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_UPLOAD_ROOT = tmpRoot;
    vi.mocked(getApiSession).mockResolvedValue({
      id: "u1",
      email: "a@a",
      name: "A",
      role: "admin",
    });
    vi.mocked(getUserPermissions).mockClear();
    vi.mocked(authorizeUploadAccess).mockResolvedValue("ok");
    vi.mocked(authorizeUploadAccess).mockClear();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValue(null);
    vi.mocked(resolveProtectedServeMeta).mockClear();
    vi.mocked(writeAuditLog).mockClear();
  });

  function mockUnauthenticated() {
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
  }

  async function writeFile(rel: string, bytes: Buffer) {
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }

  it("無認証 401 に ETag / Cache-Control を載せない（ヘッダ衛生）", async () => {
    mockUnauthenticated();
    const res = await callGet(["properties", "p1", "photos", "noauth.png"]);
    expect(res.status).toBe(401);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("無認証 + If-None-Match 一致偽装でも 401・ETag / Cache-Control なし（304 にしない）", async () => {
    // 実体ファイルが存在し、かつ正しい key 由来 ETag を client が偽装しても、
    // 認可前に 304 もキャッシュヘッダも返さない。
    const rel = "properties/p1/photos/forged.png";
    await writeFile(rel, Buffer.from([1, 2, 3]));
    mockUnauthenticated();
    const res = await callGet(["properties", "p1", "photos", "forged.png"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("無認証 + If-None-Match: * でも 401・ETag / Cache-Control なし", async () => {
    // VPS 外形チェックと同形（`*` は実体があれば常に一致扱いになる最強の偽装）。
    const rel = "properties/p1/photos/star-noauth.png";
    await writeFile(rel, Buffer.from([1]));
    mockUnauthenticated();
    const res = await callGet(
      ["properties", "p1", "photos", "star-noauth.png"],
      { headers: { "If-None-Match": "*" } },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("無認証の registry パスも 401・registry 解決/認可/監査/配信ヘッダが一切発生しない", async () => {
    const rel = "properties/p1/registry/noauth.pdf";
    await writeFile(rel, Buffer.from("%PDF-1.4 noauth"));
    mockUnauthenticated();
    const res = await callGet(["properties", "p1", "registry", "noauth.pdf"], {
      headers: { "If-None-Match": buildUploadsEtag(rel) },
    });
    expect(res.status).toBe(401);
    // 401 に registry 配信ヘッダ・キャッシュヘッダの痕跡を残さない
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Content-Disposition")).toBeNull();
    // auth が最初に走り、後段（permissions / authorize / registry 解決 / 監査）は
    // 一切実行されない（順序ロック）
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(authorizeUploadAccess).not.toHaveBeenCalled();
    expect(resolveProtectedServeMeta).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("registry preview（If-None-Match なし）にも ETag を発行しない", async () => {
    // 既存ロック（:658-）は If-None-Match 併送時のみ ETag null を assert していた。
    // 素の preview / download でも ETag 不発行であることを固定する。
    const rel = "properties/p1/registry/plain.pdf";
    await writeFile(rel, Buffer.from("%PDF-1.4 plain"));
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REGISTRY_META);

    const res = await callGet(["properties", "p1", "registry", "plain.pdf"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("registry download（If-None-Match なし）にも ETag を発行しない", async () => {
    const rel = "properties/p1/registry/plain-dl.pdf";
    await writeFile(rel, Buffer.from("%PDF-1.4 plain dl"));
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REGISTRY_META);

    const res = await callGet(["properties", "p1", "registry", "plain-dl.pdf"], {
      query: "?download=1",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // ここが見張るのは「添付として落ちること」。保存名そのものは共通関数側で固定する。
    expect(res.headers.get("Content-Disposition")).toContain(
      'attachment; filename="registry.pdf"',
    );
  });
});

// ============================================================
// 反響資料(referral) の配信ヘッダ（@codex PR#414 24巡目）
//
// ⚠referral PDF には所有者の氏名・住所・電話・メールが入っているのに、
//   非 registry として `private, no-cache` + ETag で配信していた。
//   一度開いた利用者は**権限を剥がされても最大1時間はブラウザキャッシュから
//   読めて**しまう（認可ゲートに到達しない）。registry と同じ扱いにする。
// ============================================================
describe("referral 配信ヘッダ（no-store / 304 対象外 / 定型名）", () => {
  const REFERRAL_META = {
    kind: "referral" as const,
    attachmentId: "att-ref-1",
    propertyId: "prop-1",
    // JST 2026-08-26。
    createdAt: new Date("2026-08-25T16:00:00.000Z") as Date | null,
  };

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
    vi.mocked(resolveProtectedServeMeta).mockResolvedValue(null);
    vi.mocked(writeAuditLog).mockClear();
  });

  async function writeReferralPdf() {
    const rel = "properties/p1/paste-import/1-abc.pdf";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from("%PDF-1.4 referral"));
    return ["properties", "p1", "paste-import", "1-abc.pdf"];
  }

  it("★referral preview: Cache-Control が no-store（キャッシュに残さない）", async () => {
    const parts = await writeReferralPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REFERRAL_META);

    const res = await callGet(parts);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });

  it("★referral には ETag を発行しない（no-store と 304 は両立しない）", async () => {
    const parts = await writeReferralPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REFERRAL_META);

    const res = await callGet(parts);
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("★If-None-Match を送っても 304 にならず、毎回全量配信される", async () => {
    const parts = await writeReferralPdf();
    const etag = buildUploadsEtag("properties/p1/paste-import/1-abc.pdf");
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REFERRAL_META);

    const res = await callGet(parts, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("★referral download: 定型名で落ちる（元のファイル名は使わない）", async () => {
    const parts = await writeReferralPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REFERRAL_META);

    const res = await callGet(parts, { query: "?download=1" });
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toBe(
      referralContentDisposition({ downloadIntent: true, createdAt: REFERRAL_META.createdAt }),
    );
    expect(cd).toContain("attachment");
    // 日本語名は RFC5987 で符号化され、ASCII フォールバックが付く。
    expect(cd).toContain('filename="referral.pdf"');
    expect(cd).toContain("filename*=UTF-8''");
    // 元のファイル名（所有者名を含み得る）は出ない。
    expect(cd).not.toContain("1-abc.pdf");
  });

  it("★referral では監査を書かない（registry の既存仕様に足していない）", async () => {
    const parts = await writeReferralPdf();
    vi.mocked(resolveProtectedServeMeta).mockResolvedValueOnce(REFERRAL_META);

    await callGet(parts);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("保護対象でない添付（写真・一般添付）のヘッダは不変", async () => {
    const rel = "properties/abc/photos/x.png";
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    const res = await callGet(["properties", "abc", "photos", "x.png"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("ETag")).toBe(buildUploadsEtag(rel));
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });
});
