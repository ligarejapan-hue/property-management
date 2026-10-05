import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      const zod = (e as { name?: string })?.name === "ZodError";
      return Response.json({ error: { code: zod ? "VALIDATION_ERROR" : "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: zod ? 422 : 500 });
    }),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmScenario: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(async () => ({})) },
    dmLpAsset: { findFirst: vi.fn() },
    $queryRaw: vi.fn(async () => [{ id: "s1", deleted_at: null }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { PUT } from "../../app/api/properties/sale-dm/scenarios/[id]/letter-illustration/route";
import { GET } from "../../app/api/properties/sale-dm/scenarios/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmScenario: { findFirst: Fn; findUniqueOrThrow: Fn; update: Fn };
  dmLpAsset: { findFirst: Fn };
  $queryRaw: Fn;
};
const SID = "44444444-4444-4444-8444-444444444444";
const AID = "11111111-1111-4111-8111-111111111111";
const PID = "0123456789abcdef0123456789abcdef";
const ctx = { params: Promise.resolve({ id: SID }) };
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }) as never, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ letterIllustrationAssetId: null });
  pm.dmLpAsset.findFirst.mockResolvedValue({ publicId: PID, width: 1200, height: 400, deletedAt: null });
  pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: null }]);
});

describe("PUT /scenarios/[id]/letter-illustration", () => {
  it("写真を選ぶ: 台帳→写真の順にロックし、保存して描画用の値を返す", async () => {
    const res = await put({ assetId: AID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ letterIllustrationAssetId: AID, letterIllustration: { src: `/lp-assets/${PID}`, width: 1200, height: 400 } });
    expect(pm.dmScenario.update).toHaveBeenCalledWith({ where: { id: SID }, data: { letterIllustrationAssetId: AID } });
    const sqls = pm.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    const iScenario = sqls.findIndex((s) => /dm_scenarios/.test(s));
    const iAsset = sqls.findIndex((s) => /FROM dm_lp_assets[\s\S]*FOR UPDATE/.test(s));
    expect(iScenario).toBeGreaterThan(-1);
    expect(iAsset).toBeGreaterThan(iScenario);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "sale_dm_scenario_letter_illustration_update", targetTable: "dm_scenarios", targetId: SID, detail: { hasIllustration: true } }));
  });

  it("外す: null を保存し、写真はロックしない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ letterIllustrationAssetId: AID });
    const res = await put({ assetId: null });
    expect(await res.json()).toEqual({ letterIllustrationAssetId: null, letterIllustration: null });
    expect(pm.dmScenario.update).toHaveBeenCalledWith({ where: { id: SID }, data: { letterIllustrationAssetId: null } });
    expect(pm.dmLpAsset.findFirst).not.toHaveBeenCalled();
    expect(writeAuditLog.mock.calls[0][0].detail).toEqual({ hasIllustration: false });
  });

  it("削除済みの写真は 400 ASSET_NOT_FOUND で何も書かない", async () => {
    pm.dmLpAsset.findFirst.mockResolvedValue(null);
    const res = await put({ assetId: AID });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ASSET_NOT_FOUND");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("同じ値なら書かない・監査も残さない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ letterIllustrationAssetId: AID });
    const res = await put({ assetId: AID });
    expect(res.status).toBe(200);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("assetId が uuid でなければ 422", async () => {
    expect((await put({ assetId: "x" })).status).toBe(422);
  });

  it("管理者以外は 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    expect((await put({ assetId: AID })).status).toBe(403);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });
});

describe("GET /scenarios/[id] は手紙のイラストを描画用の形で返す", () => {
  it("relation そのものは返さず letterIllustration を付ける", async () => {
    pm.dmScenario.findFirst.mockResolvedValue({ id: SID, name: "相続", letterIllustrationAssetId: AID, letterIllustrationAsset: { publicId: PID, width: 1200, height: 400, deletedAt: null } });
    const j = await (await GET(new Request("http://x"), ctx)).json();
    expect(j.scenario.letterIllustration).toEqual({ src: `/lp-assets/${PID}`, width: 1200, height: 400 });
    expect(j.scenario.letterIllustrationAssetId).toBe(AID);
    expect(j.scenario).not.toHaveProperty("letterIllustrationAsset");
  });
  it("未登録なら null", async () => {
    pm.dmScenario.findFirst.mockResolvedValue({ id: SID, name: "相続", letterIllustrationAssetId: null, letterIllustrationAsset: null });
    const j = await (await GET(new Request("http://x"), ctx)).json();
    expect(j.scenario.letterIllustration).toBeNull();
  });
});
