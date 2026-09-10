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
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn(async () => ({ id: "c1", createdBy: "u1" })) },
    dmLpVariant: { findFirst: vi.fn() },
    dmLpVariantMedia: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(async () => ({ count: 0 })) },
    dmLpAsset: { findMany: vi.fn(async () => []) },
    dmRecipientDraft: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    property: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET, PUT } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route";
import { GET as PROMPT } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/image-prompt/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmLpVariant: { findFirst: Fn };
  dmLpVariantMedia: { findMany: Fn; deleteMany: Fn; createMany: Fn };
  dmLpAsset: { findMany: Fn };
  dmRecipientDraft: { count: Fn; findMany: Fn };
  property: { findMany: Fn };
  $queryRaw: Fn;
};
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: "c1", lpId: "lp1" }) };
const BODY = "■売却の進め方\n流れの説明\n■費用について\n費用の説明";
const variant = (over: Record<string, unknown> = {}) => ({ id: "lp1", campaignId: "c1", appeal: "inheritance", lead: "ご所有の{{物件種別}}について", bodyText: BODY, templateFrozenAt: null, ...over });
const put = (plan: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(plan) }) as never, ctx);
const okPlan = { hero: { assetId: U1 }, sections: [{ heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } }, { heading: "費用について", media: { kind: "asset", assetId: U2 } }] };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmLpVariant.findFirst.mockResolvedValue(variant());
  pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }, { id: U2 }]);
  pm.dmRecipientDraft.count.mockResolvedValue(0);
});

describe("GET media", () => {
  it("本文に同じ■見出しが2回あっても節は1件にまとめる", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ bodyText: "■費用について\nA\n■費用について\nB" }));
    pm.dmLpVariantMedia.findMany.mockResolvedValue([]);
    pm.dmLpAsset.findMany.mockResolvedValue([]);
    const j = await (await GET(new Request("http://x") as never, ctx)).json();
    expect(j.headings).toEqual(["費用について"]);
    expect(j.plan.sections).toEqual([{ heading: "費用について", media: null }]);
  });
  it("DB行を枠に組み立て、本文の小見出し一覧と凍結状態とライブラリを返す", async () => {
    pm.dmLpVariantMedia.findMany.mockResolvedValue([
      { slot: "hero", heading: null, assetId: U1, figureKind: null, sortOrder: 0 },
      { slot: "section", heading: "費用について", assetId: null, figureKind: "cost_breakdown", sortOrder: 1 },
    ]);
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1, publicId: "p", mime: "image/jpeg", width: 1, height: 1, bytes: 1, label: null, createdAt: new Date(), _count: { media: 1 } }]);
    const j = await (await GET(new Request("http://x") as never, ctx)).json();
    expect(j.plan).toEqual({ hero: { assetId: U1 }, sections: [{ heading: "売却の進め方", media: null }, { heading: "費用について", media: { kind: "figure", figureKind: "cost_breakdown" } }] });
    expect(j.headings).toEqual(["売却の進め方", "費用について"]);
    expect(j.frozen).toBe(false);
    expect(j.assets[0]).toMatchObject({ id: U1, referenced: true });
    expect(JSON.stringify(j)).not.toContain("storageKey");
  });
});

describe("PUT media", () => {
  it("LP型行をロックし、行を入れ替えて保存し、監査に件数だけ残す", async () => {
    const res = await put(okPlan);
    expect(res.status).toBe(200);
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("dm_lp_variants");
    // 最後の $queryRaw は写真の実在確認をロックする dm_lp_assets で、行の入れ替え(deleteMany)より先に走る。
    const lastQueryRawIdx = pm.$queryRaw.mock.calls.length - 1;
    expect(String(pm.$queryRaw.mock.calls[lastQueryRawIdx][0])).toContain("dm_lp_assets");
    expect(pm.$queryRaw.mock.invocationCallOrder[lastQueryRawIdx]).toBeLessThan(pm.dmLpVariantMedia.deleteMany.mock.invocationCallOrder[0]);
    expect(pm.dmLpVariantMedia.deleteMany.mock.calls[0][0].where).toEqual({ lpVariantId: "lp1" });
    const rows = pm.dmLpVariantMedia.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      { lpVariantId: "lp1", slot: "hero", heading: null, assetId: U1, figureKind: null, sortOrder: 0 },
      { lpVariantId: "lp1", slot: "section", heading: "売却の進め方", assetId: null, figureKind: "sale_flow", sortOrder: 1 },
      { lpVariantId: "lp1", slot: "section", heading: "費用について", assetId: U2, figureKind: null, sortOrder: 2 },
    ]);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "sale_dm_lp_media_update", detail: { campaignId: "c1", assetCount: 2, figureCount: 1 } });
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("売却の進め方");
  });
  it("凍結済み(確定/送付あり または 凍結印)は初期化でも 409 VARIANT_FROZEN", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    let r = await put(okPlan);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("VARIANT_FROZEN");
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ templateFrozenAt: new Date() }));
    r = await put(okPlan);
    expect(r.status).toBe(409);
    expect(pm.dmLpVariantMedia.deleteMany).not.toHaveBeenCalled();
  });
  it("本文に無い小見出しは 400 INVALID_MEDIA_PLAN、削除済みの写真は 422 ASSET_NOT_FOUND", async () => {
    let r = await put({ hero: null, sections: [{ heading: "無い", media: null }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("INVALID_MEDIA_PLAN");
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }]);
    r = await put(okPlan);
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("ASSET_NOT_FOUND");
    expect(pm.dmLpVariantMedia.deleteMany).not.toHaveBeenCalled();
  });
  it("field_staff は担当外の宛先を含むLP型に写真を付けられない(送付済みも対象・物件行をロックして読み直す)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u9", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }, { propertyId: "p2" }]);
    pm.property.findMany.mockResolvedValue([{ id: "p1" }]);
    const r = await put(okPlan);
    expect(r.status).toBe(403);
    expect(pm.dmRecipientDraft.findMany.mock.calls[0][0].where).toEqual({ campaignId: "c1", lpVariantId: "lp1" });
    expect(String(pm.$queryRaw.mock.calls[1][0])).toContain("properties");
  });
  it("field_staff で担当範囲内なら properties を dm_lp_assets より先にロックする", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u9", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]);
    pm.property.findMany.mockResolvedValue([{ id: "p1" }]);
    const r = await put(okPlan);
    expect(r.status).toBe(200);
    const propertiesIdx = pm.$queryRaw.mock.calls.findIndex((c: unknown[]) => String(c[0]).includes("properties"));
    const assetsIdx = pm.$queryRaw.mock.calls.findIndex((c: unknown[]) => String(c[0]).includes("dm_lp_assets"));
    expect(propertiesIdx).toBeGreaterThan(-1);
    expect(assetsIdx).toBeGreaterThan(propertiesIdx);
  });
  it("本文に同じ■見出しが2回あっても、その見出し1件を指す枠の保存は通る", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ bodyText: "■費用について\nA\n■費用について\nB" }));
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }]);
    const r = await put({ hero: null, sections: [{ heading: "費用について", media: { kind: "asset", assetId: U1 } }] });
    expect(r.status).toBe(200);
  });
  it("文章が未保存(本文なし)のLP型には枠を付けられない", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue(variant({ bodyText: null }));
    const r = await put({ hero: { assetId: U1 }, sections: [] });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("TEMPLATE_MISSING");
  });
});

describe("GET image-prompt", () => {
  const q = (qs: string) => PROMPT(new Request(`http://x/?${qs}`) as never, ctx);
  it("ヒーロー用: 訴求と要旨から組み立て、監査に slot だけ残す。所有者情報は出ない", async () => {
    const j = await (await q("slot=hero&style=photo")).json();
    expect(j.prompt).toContain("16:9");
    expect(j.prompt).toContain("相続");
    expect(j.prompt).not.toContain("{{");
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "sale_dm_lp_image_prompt_view", detail: { campaignId: "c1", slot: "hero" } });
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("prompt");
  });
  it("節用: 本文に無い小見出しは 400 HEADING_NOT_FOUND", async () => {
    expect((await q("slot=section&heading=" + encodeURIComponent("費用について"))).status).toBe(200);
    const r = await q("slot=section&heading=" + encodeURIComponent("無い"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("HEADING_NOT_FOUND");
  });
});
