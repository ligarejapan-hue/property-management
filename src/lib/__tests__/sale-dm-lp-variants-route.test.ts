import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/generated/prisma", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));
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
    dmCampaign: { findFirst: vi.fn(), findUnique: vi.fn() },
    dmLpVariant: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    dmRecipientDraft: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET, POST } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/route";
import { PATCH, DELETE } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn; findUnique: Fn };
  dmLpVariant: { findMany: Fn; findFirst: Fn; create: Fn; update: Fn; deleteMany: Fn };
  dmRecipientDraft: { count: Fn };
  $queryRaw: Fn;
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const OPT = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
const ctx = { params: Promise.resolve({ id: "c1" }) };
const ctxLp = { params: Promise.resolve({ id: "c1", lpId: "l1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://x", { method, body: body === undefined ? undefined : JSON.stringify(body) }) as never;
// $queryRaw はタグ付きテンプレートで呼ばれる。第1引数(文字列配列)を結合して SQL を見る。
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
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
  pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", campaignId: "c1", ...OPT, templateFrozenAt: null });
  pm.dmLpVariant.create.mockResolvedValue({ id: "l1", label: "A" });
  pm.dmLpVariant.update.mockResolvedValue({ id: "l1", label: "A" });
  pm.dmLpVariant.deleteMany.mockResolvedValue({ count: 1 });
  pm.dmRecipientDraft.count.mockResolvedValue(0);
});

describe("GET/POST lp-variants", () => {
  it("一覧は本人のキャンペーンだけ(他人=404)", async () => {
    pm.dmCampaign.findFirst.mockResolvedValue(null);
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });
  it("作成は文体4項目とラベルを保存し、監査 sale_dm_lp_variant_create を残す", async () => {
    const res = await POST(req("POST", { label: "A", options: OPT }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dmLpVariant.create.mock.calls[0][0].data).toEqual({ campaignId: "c1", label: "A", ...OPT });
    expect((writeAuditLog as Fn).mock.calls[0][0].action).toBe("sale_dm_lp_variant_create");
  });
  it("作成は他人のキャンペーンだと 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "someone" });
    expect((await POST(req("POST", { label: "A", options: OPT }), ctx)).status).toBe(404);
  });
});

describe("PATCH lp-variants/[lpId]", () => {
  it("文体を実際に変えたら原文・切り分け結果・プロンプト控えを消す", async () => {
    const res = await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(res.status).toBe(200);
    const data = pm.dmLpVariant.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ tone: "soft", promptText: null, rawTemplate: null, headline: null, lead: null, bodyText: null });
    expect("faqJson" in data).toBe(true);
  });
  it("同じ値の再送(no-op)や label だけなら原文を消さない", async () => {
    await PATCH(req("PATCH", { label: "B", options: { tone: "formal" } }), ctxLp);
    expect(pm.dmLpVariant.update.mock.calls[0][0].data).toEqual({ label: "B", tone: "formal" });
  });
  it("凍結中(配下に確定のみ・送付済みなし)の文体変更は 409 VARIANT_LOCKED、label だけなら通る", async () => {
    // 呼び出し順: 1回目PATCH = sentCount(0) → settledCount(1・確定のみ) / 2回目PATCH(label のみ) = sentCount(0)。
    pm.dmRecipientDraft.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const r1 = await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(r1.status).toBe(409);
    expect((await r1.json()).error.code).toBe("VARIANT_LOCKED");
    expect((await PATCH(req("PATCH", { label: "B" }), ctxLp)).status).toBe(200);
  });
  it("送付済みが1件でもあれば label だけでも 409 VARIANT_LOCKED", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    const res = await PATCH(req("PATCH", { label: "B" }), ctxLp);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_LOCKED");
  });
  it("凍結印の列だけでも止まる(二重判定)", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", campaignId: "c1", ...OPT, templateFrozenAt: new Date() });
    expect((await PATCH(req("PATCH", { options: { appeal: "vacant" } }), ctxLp)).status).toBe(409);
  });
  it("dm_lp_variants 行を FOR UPDATE でロックしてから判定する", async () => {
    await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(sqlCalls().join("\n")).toMatch(/FROM dm_lp_variants[\s\S]*FOR UPDATE/);
  });
  it("存在しない LP型は 404", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(null);
    expect((await PATCH(req("PATCH", { label: "B" }), ctxLp)).status).toBe(404);
  });
});

describe("DELETE lp-variants/[lpId]", () => {
  it("宛先が居なければ削除(recipients none をアトミックに条件へ)", async () => {
    const res = await DELETE(req("DELETE"), ctxLp);
    expect(res.status).toBe(200);
    expect(pm.dmLpVariant.deleteMany.mock.calls[0][0].where).toEqual({ id: "l1", campaignId: "c1", recipients: { none: {} } });
  });
  it("凍結中は 409 VARIANT_FROZEN", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(2);
    const res = await DELETE(req("DELETE"), ctxLp);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_FROZEN");
  });
  it("割当済みなら 409 VARIANT_IN_USE", async () => {
    pm.dmLpVariant.deleteMany.mockResolvedValue({ count: 0 });
    expect((await (await DELETE(req("DELETE"), ctxLp)).json()).error.code).toBe("VARIANT_IN_USE");
  });
});
