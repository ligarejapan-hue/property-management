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
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { loadSaleDmPublicPageConfig } = vi.hoisted(() => ({ loadSaleDmPublicPageConfig: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmPublicPageConfig }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn(async () => ({ id: "c1", createdBy: "u1" })) },
    dmLpVariant: { findFirst: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn(async () => []) },
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/preview/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn };
  dmLpVariant: { findFirst: Fn };
  dmRecipientDraft: { findMany: Fn };
};

const ctx = { params: Promise.resolve({ id: "c1", lpId: "lp1" }) };
const BODY = "■売却の進め方\n流れの説明\n■費用について\n費用の説明";
const variant = (over: Record<string, unknown> = {}) => ({
  headline: "ご所有の{{物件種別}}、無料査定します",
  lead: "ご所有の{{物件所在}}の物件について",
  bodyText: BODY,
  faqJson: [],
  media: [],
  ...over,
});
const get = (qs = "") => GET(new Request(`http://x/${qs}`) as never, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1", createdBy: "u1" });
  pm.dmLpVariant.findFirst.mockResolvedValue(variant());
  pm.dmRecipientDraft.findMany.mockResolvedValue([
    { property: { propertyType: "house" } },
    { property: { propertyType: "house" } },
    { property: { propertyType: "mansion_unit" } },
  ]);
  loadSaleDmPublicPageConfig.mockResolvedValue({
    lpUrl: "https://example.com/lp",
    senderName: "テスト不動産",
    senderContact: "03-1234-5678",
    trackingBaseUrl: "https://example.com",
  });
});

describe("GET LPプレビュー(社内)", () => {
  it("文章ありで200・text/html・no-store・X-Frame-Options SAMEORIGIN・CSPがframe-ancestors self・プレビュー帯・見本の所在・氏名や番地は出ない・scriptなし・監査device=sp", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("プレビュー");
    expect(html).toContain("○○区○○町");
    expect(html).not.toContain("1-2-3");
    expect(html).not.toContain("<script");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "sale_dm_lp_preview_view",
      targetTable: "dm_lp_variants",
      targetId: "lp1",
      detail: expect.objectContaining({ campaignId: "c1", device: "sp" }),
    }));
    expect(writeAuditLog.mock.calls[0][0].detail.viewedAt).toEqual(expect.any(String));
  });

  it("文章未保存(本文なし)は409 TEMPLATE_MISSING", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ bodyText: null }));
    const res = await get();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("TEMPLATE_MISSING");
  });

  it("他人のキャンペーンは404", async () => {
    pm.dmCampaign.findFirst.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
  });

  it("deviceが不正なら400", async () => {
    const res = await get("?device=tablet");
    expect(res.status).toBe(400);
  });

  it("device=pcも通り、監査にpcが残る", async () => {
    const res = await get("?device=pc");
    expect(res.status).toBe(200);
    expect(writeAuditLog.mock.calls[0][0].detail.device).toBe("pc");
  });

  it("読み取り権限のみ(書き込み権限なし)でも200(閲覧は書き込み門でない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue(
      ["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: true })),
    );
    const res = await get();
    expect(res.status).toBe(200);
  });
});
