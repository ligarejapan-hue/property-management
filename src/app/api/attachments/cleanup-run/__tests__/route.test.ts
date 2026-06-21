import { describe, it, expect, vi, beforeEach } from "vitest";

const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }));
vi.mock("@/lib/attachment-cleanup", () => ({ purgeExpiredAttachments: purgeSpy }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

import { POST } from "../route";

const SECRET = "s3cr3t";
function req(opts: { secret?: string; dryRun?: boolean } = {}) {
  const headers = new Headers();
  if (opts.secret !== undefined) headers.set("x-cleanup-secret", opts.secret);
  return new Request(`http://localhost/api/attachments/cleanup-run${opts.dryRun ? "?dryRun=1" : ""}`, { method: "POST", headers });
}

beforeEach(() => { vi.clearAllMocks(); delete process.env.ATTACHMENT_CLEANUP_SECRET; purgeSpy.mockResolvedValue({ scanned: 3, purged: 3, failed: 0, skipped: 0 }); });

describe("POST /api/attachments/cleanup-run", () => {
  it("秘密鍵 env 未設定なら 503（dormant・purge を呼ばない）", async () => {
    const res = await POST(req({ secret: "anything" }));
    expect(res.status).toBe(503);
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it("秘密鍵が不一致なら 403", async () => {
    process.env.ATTACHMENT_CLEANUP_SECRET = SECRET;
    const res = await POST(req({ secret: "wrong" }));
    expect(res.status).toBe(403);
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it("一致すれば実行し件数を返す", async () => {
    process.env.ATTACHMENT_CLEANUP_SECRET = SECRET;
    const res = await POST(req({ secret: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 3, purged: 3, dryRun: false });
    expect(purgeSpy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, limit: 200, now: expect.any(Date) }));
  });

  it("?dryRun=1 は dryRun:true で呼ぶ", async () => {
    process.env.ATTACHMENT_CLEANUP_SECRET = SECRET;
    purgeSpy.mockResolvedValueOnce({ scanned: 5, purged: 0 });
    const res = await POST(req({ secret: SECRET, dryRun: true }));
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 5, purged: 0, dryRun: true });
    expect(purgeSpy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, now: expect.any(Date) }));
  });
});
