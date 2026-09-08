import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn() },
    dmVariant: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
    dmLpVariant: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    dmRecipientDraft: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST as assign } from "../../app/api/properties/sale-dm/campaigns/[id]/assign/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn };
  dmVariant: { findMany: Fn; updateMany: Fn };
  dmLpVariant: { findMany: Fn; updateMany: Fn };
  dmRecipientDraft: { findMany: Fn; updateMany: Fn };
  $queryRaw: Fn;
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1" }) };
const post = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) }) as never;
const prop = { createdBy: "u1", assignedTo: null };
const sqlCalls = () => pm.$queryRaw.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join("?") : String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  pm.dmVariant.findMany.mockResolvedValue([{ id: "d0" }, { id: "d1" }]);
  pm.dmLpVariant.findMany.mockResolvedValue([{ id: "l0" }, { id: "l1" }]);
  // 1回目=対象宛先(先読み)、2回目=移動元の型(sourcesPre)、3回目=確定/送付済み(movingSettled)
  pm.dmRecipientDraft.findMany
    .mockResolvedValueOnce([{ id: "r0", property: prop }, { id: "r1", property: prop }, { id: "r2", property: prop }, { id: "r3", property: prop }])
    .mockResolvedValueOnce([{ variantId: "d0", lpVariantId: null }, { variantId: "d0", lpVariantId: "l0" }])
    .mockResolvedValueOnce([{ variantId: "d1", lpVariantId: "l1" }]);
});

describe("POST assign(両軸)", () => {
  it("auto は DM型と LP型の両方へ総当たりで割り当て、LP側は本文を消さない", async () => {
    const res = await assign(post({ mode: "auto" }), ctx);
    expect(res.status).toBe(200);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    const dmCalls = calls.filter((c) => "variantId" in c.data);
    const lpCalls = calls.filter((c) => "lpVariantId" in c.data);
    expect(dmCalls.length).toBe(2);
    expect(lpCalls.length).toBe(2);
    for (const c of lpCalls) {
      expect(c.data).toEqual({ lpVariantId: expect.any(String) });
      expect(c.where).toMatchObject({ campaignId: "c1", status: { not: "sent" }, NOT: { lpVariantId: c.data.lpVariantId } });
    }
    const j = await res.json();
    expect(j).toHaveProperty("perLpVariant");
    expect(j).toHaveProperty("assignedLp");
  });
  it("LP型が0件なら LP側の updateMany を呼ばない(既存キャンペーンの挙動不変)", async () => {
    pm.dmLpVariant.findMany.mockResolvedValue([]);
    await assign(post({ mode: "auto" }), ctx);
    const lpCalls = pm.dmRecipientDraft.updateMany.mock.calls.filter((c) => "lpVariantId" in c[0].data);
    expect(lpCalls.length).toBe(0);
  });
  it("移動元の LP型(確定/送付済み)へ凍結印を立て、ロックは dm_variants → dm_lp_variants の順", async () => {
    await assign(post({ mode: "auto" }), ctx);
    expect(pm.dmLpVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["l1"] }, templateFrozenAt: null } }));
    const sql = sqlCalls();
    const v = sql.findIndex((s) => /dm_variants/.test(s) && !/dm_lp_variants/.test(s));
    const l = sql.findIndex((s) => /dm_lp_variants/.test(s));
    expect(v).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(v);
  });
  it("manual は assignments と lpAssignments を軸ごとに独立に反映する", async () => {
    await assign(post({ mode: "manual", lpAssignments: [{ recipientId: "r2", lpVariantId: "l1" }] }), ctx);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => "variantId" in c.data).length).toBe(0);
    const lp = calls.filter((c) => "lpVariantId" in c.data);
    expect(lp.length).toBe(1);
    expect(lp[0].where.id).toEqual({ in: ["r2"] });
    expect(lp[0].data).toEqual({ lpVariantId: "l1" });
  });
});
