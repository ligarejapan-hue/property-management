/**
 * ドライブの見回りの実行口(timer 用・第2段b): 合言葉・休眠・重なり・応答に名前が無いこと。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const run = vi.fn();
vi.mock("@/lib/drive/sync-run", () => ({ runDriveSync: (...a: unknown[]) => run(...a) }));
vi.mock("@/lib/drive/sync-live", () => ({ liveRunDeps: () => ({}) }));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; code?: string };
      return new Response(JSON.stringify({ code: err.code }), { status: err.status ?? 500 });
    },
  };
});

import { POST } from "../route";
import { isPublicPath } from "@/proxy";

const SECRET = "drive-sync-secret-value";
let saved: string | undefined;
const req = (secret?: string) =>
  new Request("http://localhost/api/drive/sync-run", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-drive-sync-secret": secret },
  });
const RESULT = { links: 2, linkErrors: 0, totals: { imported: 1 }, nextStartAt: 1 };

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue(RESULT);
  saved = process.env.DRIVE_SYNC_SECRET;
  delete process.env.DRIVE_SYNC_SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.DRIVE_SYNC_SECRET;
  else process.env.DRIVE_SYNC_SECRET = saved;
});

describe("POST /api/drive/sync-run", () => {
  it("合言葉が未設定なら 503(休眠)・何もしない", async () => {
    const res = await POST(req(SECRET));
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it("合言葉が違う・無い・長さ違いは 403", async () => {
    process.env.DRIVE_SYNC_SECRET = SECRET;
    expect((await POST(req("wrong"))).status).toBe(403);
    expect((await POST(req())).status).toBe(403);
    expect((await POST(req(SECRET + "x"))).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it("合っていれば見回り・前回の続きの物件から(開始位置を引き継ぐ)・応答は件数だけ", async () => {
    process.env.DRIVE_SYNC_SECRET = SECRET;
    const res = await POST(req(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(run.mock.calls[0][1]).toEqual({ budget: 20, startAt: expect.any(Number) });
    await POST(req(SECRET));
    expect(run.mock.calls[1][1].startAt).toBe(1);
  });
  it("前の見回りが終わっていなければ 409(重ねない)", async () => {
    process.env.DRIVE_SYNC_SECRET = SECRET;
    let release!: () => void;
    run.mockImplementationOnce(() => new Promise((r) => (release = () => r(RESULT))));
    const first = POST(req(SECRET));
    await new Promise((r) => setTimeout(r, 0));
    expect((await POST(req(SECRET))).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    // 終われば次は動く
    expect((await POST(req(SECRET))).status).toBe(200);
  });
  it("見回りが例外で止まっても、次は動く(重なりの印が残らない)", async () => {
    process.env.DRIVE_SYNC_SECRET = SECRET;
    run.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(req(SECRET))).status).toBe(500);
    expect((await POST(req(SECRET))).status).toBe(200);
  });
  it("ログインなしで timer から呼べる(proxy の公開パス)・似た道は公開しない", () => {
    expect(isPublicPath("/api/drive/sync-run")).toBe(true);
    expect(isPublicPath("/api/drive/sync-run-x")).toBe(false);
  });
});
