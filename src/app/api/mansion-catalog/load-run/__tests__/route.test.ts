import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const upsertMany = vi.fn(async (rows: unknown[]) => ({ inserted: rows.length, updated: 0 }));
vi.mock("@/lib/mansion-catalog/store", () => ({ createPrismaCatalogStore: () => ({ upsertMany }) }));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error {
    constructor(public status: number, message: string, public code = "ERROR") { super(message); }
  }
  return {
    ApiError: MockApiError,
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status ?? 500 });
    },
  };
});
import { POST } from "../route";

const LINE = JSON.stringify({ pref: "13", page: 1, fetchedAt: "2026-10-17T00:00:00Z", id: "1", name: "棟", address: "東京都葛飾区青戸4丁目2番14号", stations: [], completed: null, structure: null, floors: null, units: null, developer: null, manager: null });
const req = (secret?: string) =>
  new Request("http://localhost/api/mansion-catalog/load-run", { method: "POST", headers: secret ? { "x-mansion-catalog-secret": secret } : {} });

let dir: string;
const saved = { s: process.env.MANSION_CATALOG_LOAD_SECRET, d: process.env.MANSION_CATALOG_DIR };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-"));
  upsertMany.mockClear();
  delete process.env.MANSION_CATALOG_LOAD_SECRET;
  delete process.env.MANSION_CATALOG_DIR;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.s === undefined) delete process.env.MANSION_CATALOG_LOAD_SECRET; else process.env.MANSION_CATALOG_LOAD_SECRET = saved.s;
  if (saved.d === undefined) delete process.env.MANSION_CATALOG_DIR; else process.env.MANSION_CATALOG_DIR = saved.d;
});

describe("POST /api/mansion-catalog/load-run", () => {
  it("合言葉が未設定なら 503(休眠)", async () => {
    expect((await POST(req("x"))).status).toBe(503);
  });
  it("合言葉が違えば 403・何も読まない", async () => {
    process.env.MANSION_CATALOG_LOAD_SECRET = "s3cret";
    process.env.MANSION_CATALOG_DIR = dir;
    expect((await POST(req("nope"))).status).toBe(403);
    expect(upsertMany).not.toHaveBeenCalled();
  });
  it("フォルダが未設定なら 503", async () => {
    process.env.MANSION_CATALOG_LOAD_SECRET = "s3cret";
    expect((await POST(req("s3cret"))).status).toBe(503);
  });
  it("決まった名前のファイルだけ読み、件数だけ返す", async () => {
    process.env.MANSION_CATALOG_LOAD_SECRET = "s3cret";
    process.env.MANSION_CATALOG_DIR = dir;
    writeFileSync(join(dir, "buildings-13.jsonl"), LINE + "\n{\n");
    writeFileSync(join(dir, "other.jsonl"), LINE + "\n");
    const res = await POST(req("s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ files: 1, inserted: 1, updated: 0, skipped: 1, duplicates: 0 });
  });
  it("proxy の公開リストに載っている(無いと 307 でログインへ飛ばされる)", () => {
    const src = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
    expect(src).toContain('"/api/mansion-catalog/load-run"');
  });
});
