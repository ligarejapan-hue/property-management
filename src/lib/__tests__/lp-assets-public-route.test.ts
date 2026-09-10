import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
const { storageStub } = vi.hoisted(() => ({ storageStub: { read: vi.fn(), upload: vi.fn(), delete: vi.fn(), getUrl: vi.fn(), keyFromUrl: vi.fn() } }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storageStub }));
vi.mock("@/lib/prisma", () => ({ default: { dmLpAsset: { findUnique: vi.fn() } } }));

import prismaMock from "@/lib/prisma";
import { GET } from "../../app/lp-assets/[publicId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dmLpAsset: { findUnique: Fn } };
const PID = "a".repeat(32);
const ctx = (publicId: string) => ({ params: Promise.resolve({ publicId }) });
const req = (ip = "10.0.0.1") => new Request(`http://x/lp-assets/${PID}`, { headers: { "x-real-ip": ip } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  pm.dmLpAsset.findUnique.mockResolvedValue({ storageKey: "lp-assets/k.jpg", mime: "image/jpeg", deletedAt: null, _count: { media: 1 } });
  storageStub.read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "application/octet-stream", size: 3 });
});

describe("GET /lp-assets/[publicId]", () => {
  it("参照中の資産を長期キャッシュで返す(Content-Type は保存時の mime)", async () => {
    const res = await GET(req(), ctx(PID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe("3");
    expect(pm.dmLpAsset.findUnique.mock.calls[0][0].where).toEqual({ publicId: PID });
  });
  it("未参照・削除済み・未知・形式不正は 404(本文なし・no-store・DB/storage を叩かない場合も)", async () => {
    pm.dmLpAsset.findUnique.mockResolvedValue({ storageKey: "k", mime: "image/jpeg", deletedAt: null, _count: { media: 0 } });
    expect((await GET(req("10.0.0.2"), ctx(PID))).status).toBe(404);
    pm.dmLpAsset.findUnique.mockResolvedValue({ storageKey: "k", mime: "image/jpeg", deletedAt: new Date(), _count: { media: 1 } });
    expect((await GET(req("10.0.0.3"), ctx(PID))).status).toBe(404);
    pm.dmLpAsset.findUnique.mockResolvedValue(null);
    expect((await GET(req("10.0.0.4"), ctx(PID))).status).toBe(404);
    pm.dmLpAsset.findUnique.mockClear();
    const bad = await GET(req("10.0.0.5"), ctx("../etc/passwd"));
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    expect(pm.dmLpAsset.findUnique).not.toHaveBeenCalled();
  });
  it("storage に実体が無ければ 404", async () => {
    storageStub.read.mockResolvedValue(null);
    expect((await GET(req("10.0.0.6"), ctx(PID))).status).toBe(404);
  });
  it("同じ端末から1分に300回を超えると 429", async () => {
    let last = 200;
    for (let i = 0; i < 301; i++) last = (await GET(req("10.9.9.9"), ctx(PID))).status;
    expect(last).toBe(429);
  });
});
