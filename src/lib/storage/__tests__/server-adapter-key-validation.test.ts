/**
 * ServerStorageAdapter key validation test (Phase 2 Codex P1).
 *
 * read で encodeURIComponent("..") が ".." のまま URL に乗り、server backend の
 * path normalize で "/{bucket}" prefix の外へ抜けるリグレッションを防ぐ。
 *
 * 重点:
 *   - read / upload / getUrl: traversal key で throw（fetch を呼ばない）
 *   - delete: traversal key で早期 return（fetch を呼ばない）
 *   - 正常 key は従来どおり読める（fetch が 1 回呼ばれ、組み立て URL に
 *     ".." セグメントが含まれない）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ServerStorageAdapter } from "../server-adapter";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function setServerEnv() {
  process.env.STORAGE_SERVER_URL = "https://files.example.test";
  process.env.STORAGE_SERVER_API_KEY = "test-api-key";
  process.env.STORAGE_SERVER_BUCKET = "test-bucket";
}

beforeEach(() => {
  setServerEnv();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("STORAGE_")) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

const TRAVERSAL_KEYS = [
  "../etc/passwd",
  "properties/1/photos/../secret.jpg",
  "properties\\1\\secret.jpg",
  "a/./b",
  "/abs/path",
  "",
  ".",
  "..",
  "a//b",
];

describe("ServerStorageAdapter.read traversal rejection", () => {
  it.each(TRAVERSAL_KEYS)(
    "rejects %j without calling fetch",
    async (badKey) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const adapter = new ServerStorageAdapter();
      await expect(adapter.read(badKey)).rejects.toThrow(/path traversal/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("正常 key は従来どおり fetch を呼び、組み立て URL に '..' が含まれない", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const adapter = new ServerStorageAdapter();
    const result = await adapter.read("properties/abc/photos/1.jpg");
    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain("/test-bucket/properties/abc/photos/1.jpg");
    expect(calledUrl).not.toMatch(/\.\.(\/|$)/);
  });
});

describe("ServerStorageAdapter.upload traversal rejection", () => {
  it.each(TRAVERSAL_KEYS)(
    "rejects %j without calling fetch",
    async (badKey) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const adapter = new ServerStorageAdapter();
      await expect(
        adapter.upload(Buffer.alloc(1), {
          key: badKey,
          mimeType: "text/plain",
          fileName: "x",
        }),
      ).rejects.toThrow(/path traversal/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("ServerStorageAdapter.getUrl traversal rejection", () => {
  it.each(TRAVERSAL_KEYS)(
    "rejects %j without calling fetch",
    async (badKey) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const adapter = new ServerStorageAdapter();
      await expect(adapter.getUrl(badKey)).rejects.toThrow(/path traversal/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("ServerStorageAdapter.delete traversal handling", () => {
  it.each(TRAVERSAL_KEYS)(
    "silently no-ops on %j without calling fetch (他 adapter と整合)",
    async (badKey) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const adapter = new ServerStorageAdapter();
      await expect(adapter.delete(badKey)).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("正常 key は従来どおり fetch を呼ぶ", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const adapter = new ServerStorageAdapter();
    await adapter.delete("properties/abc/photos/1.jpg");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
