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
    dmCampaign: { findFirst: vi.fn() },
    dmLpVariant: { findFirst: vi.fn(), update: vi.fn() },
    dmRecipientDraft: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    property: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/prompt/route";
import { PUT } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/template/route";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "../sale-dm-letter/external-prompt";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn };
  dmLpVariant: { findFirst: Fn; update: Fn };
  dmRecipientDraft: { count: Fn; findMany: Fn };
  property: { findMany: Fn };
  $queryRaw: Fn;
};
const OPT = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
const DIGEST = promptDigest(buildLpExternalPrompt(OPT));
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1", lpId: "l1" }) };
const GOOD = "【見出し】タイトル\n【本文】本文です\n【よくある質問】\nQ. a\nA. b";
let armedRaw: string | null = null;
const put = (b: Record<string, unknown>) =>
  new Request("http://x", { method: "PUT", body: JSON.stringify({ promptDigest: DIGEST, baseBodyDigest: bodyTemplateDigest(armedRaw), ...b }) }) as never;
function arm(over: Record<string, unknown> = {}) {
  armedRaw = ("rawTemplate" in over ? over.rawTemplate : null) as string | null;
  pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", ...OPT, templateFrozenAt: null, rawTemplate: null, ...over });
}
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
  arm();
  pm.dmRecipientDraft.count.mockResolvedValue(0);
  pm.dmRecipientDraft.findMany.mockResolvedValue([]);
  pm.property.findMany.mockResolvedValue([]);
  pm.dmLpVariant.update.mockResolvedValue({ id: "l1" });
});

describe("GET lp prompt", () => {
  it("LP用プロンプト・指紋・凍結・原文の指紋を返し、監査を残す", async () => {
    const res = await GET(new Request("http://x") as never, ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.prompt).toContain("【よくある質問】");
    expect(j.digest).toBe(DIGEST);
    expect(j.frozen).toBe(false);
    expect(j.rawTemplate).toBeNull();
    expect(j.bodyDigest).toBe(bodyTemplateDigest(null));
    expect((writeAuditLog as Fn).mock.calls[0][0].action).toBe("sale_dm_lp_prompt_view");
  });
  it("存在しない LP型は 404", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(null);
    expect((await GET(new Request("http://x") as never, ctx)).status).toBe(404);
  });
});

describe("PUT lp template(貼り戻し保存)", () => {
  it("切り分けて原文と4部位を同じ処理で保存し、要約を返す", async () => {
    const res = await PUT(put({ body: GOOD }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmLpVariant.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ rawTemplate: GOOD, headline: "タイトル", lead: null, bodyText: "本文です", faqJson: [{ q: "a", a: "b" }] });
    expect(typeof data.promptText).toBe("string");
    const j = await res.json();
    expect(j).toMatchObject({ changed: true, bodyDigest: bodyTemplateDigest(GOOD), parts: { headline: "タイトル", faqCount: 1, bodyLength: 4 } });
    expect((writeAuditLog as Fn).mock.calls[0][0].action).toBe("sale_dm_lp_body_paste");
  });
  it("見出しの欠けは 400 INVALID_LP_TEMPLATE で保存しない", async () => {
    const res = await PUT(put({ body: "【本文】b" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_LP_TEMPLATE");
    expect(pm.dmLpVariant.update).not.toHaveBeenCalled();
  });
  it("同じ原文の再保存は何も書かない", async () => {
    arm({ rawTemplate: GOOD });
    const res = await PUT(put({ body: GOOD }), ctx);
    expect((await res.json()).changed).toBe(false);
    expect(pm.dmLpVariant.update).not.toHaveBeenCalled();
  });
  it("プロンプトの指紋がずれていたら 409 PROMPT_STALE", async () => {
    const res = await PUT(put({ body: GOOD, promptDigest: "0".repeat(64) }), ctx);
    expect((await res.json()).error.code).toBe("PROMPT_STALE");
  });
  it("原文の指紋がずれていたら 409 TEMPLATE_STALE", async () => {
    arm({ rawTemplate: "【見出し】old\n【本文】old" });
    const res = await PUT(put({ body: GOOD, baseBodyDigest: bodyTemplateDigest("違う") }), ctx);
    expect((await res.json()).error.code).toBe("TEMPLATE_STALE");
  });
  it("凍結中の差し替えは 409 VARIANT_FROZEN、原文が無ければ初期化として許可", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    arm({ rawTemplate: "【見出し】old\n【本文】old" });
    expect((await (await PUT(put({ body: GOOD }), ctx)).json()).error.code).toBe("VARIANT_FROZEN");
    arm();
    expect((await PUT(put({ body: GOOD }), ctx)).status).toBe(200);
  });
  it("field_staff は担当外の未送付宛先が居ると 403", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]);
    pm.property.findMany.mockResolvedValue([]);
    expect((await PUT(put({ body: GOOD }), ctx)).status).toBe(403);
  });
  it("ロックは dm_lp_variants → properties の順", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]);
    pm.property.findMany.mockResolvedValue([{ id: "p1" }]);
    await PUT(put({ body: GOOD }), ctx);
    const sql = sqlCalls();
    expect(sql[0]).toMatch(/dm_lp_variants/);
    expect(sql[1]).toMatch(/properties/);
  });
});
