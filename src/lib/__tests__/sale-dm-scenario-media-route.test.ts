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
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { loadSaleDmPublicPageConfig } = vi.hoisted(() => ({ loadSaleDmPublicPageConfig: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmPublicPageConfig }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmScenario: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
    dmScenarioMedia: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(async () => ({ count: 0 })) },
    dmLpAsset: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: "s1", deleted_at: null }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET, PUT } from "../../app/api/properties/sale-dm/scenarios/[id]/media/route";
import { GET as PREVIEW } from "../../app/api/properties/sale-dm/scenarios/[id]/preview/route";
import { GET as PROMPT } from "../../app/api/properties/sale-dm/scenarios/[id]/image-prompt/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmScenario: { findFirst: Fn; findUniqueOrThrow: Fn };
  dmScenarioMedia: { findMany: Fn; deleteMany: Fn; createMany: Fn };
  dmLpAsset: { findMany: Fn };
  $queryRaw: Fn;
};

const SID = "44444444-4444-4444-8444-444444444444";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: SID }) };
const BODY = "■売却の進め方\n流れの説明\n■費用について\n費用の説明";

const scenarioRow = (over: Record<string, unknown> = {}) => ({
  id: SID,
  lpAppeal: "inheritance",
  lpHeadline: "見出しA",
  lpLead: "ご所有の{{物件所在}}の物件について",
  lpBodyText: BODY,
  lpFaqJson: [],
  media: [],
  deletedAt: null,
  ...over,
});

const put = (plan: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(plan) }) as never, ctx);
const okPlan = { hero: { assetId: U1 }, sections: [{ heading: "売却の進め方", media: { kind: "figure", figureKind: "sale_flow" } }, { heading: "費用について", media: { kind: "asset", assetId: U2 } }] };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.dmScenario.findFirst.mockResolvedValue(scenarioRow());
  pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow());
  pm.dmScenarioMedia.findMany.mockResolvedValue([]);
  pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }, { id: U2 }]);
  pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: null }]);
  loadSaleDmPublicPageConfig.mockResolvedValue({
    senderName: "テスト不動産",
    senderContact: "03-1234-5678",
    trackingBaseUrl: "https://example.com",
    privacyText: null,
  });
});

describe("GET /scenarios/[id]/media(台帳の写真と図)", () => {
  it("DB行を枠に組み立て、本文の小見出し一覧とライブラリを返す(frozen は無い)", async () => {
    pm.dmScenarioMedia.findMany.mockResolvedValue([
      { slot: "hero", heading: null, assetId: U1, figureKind: null, sortOrder: 0 },
      { slot: "section", heading: "費用について", assetId: null, figureKind: "cost_breakdown", sortOrder: 1 },
    ]);
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1, publicId: "p", mime: "image/jpeg", width: 1, height: 1, bytes: 1, label: null, createdAt: new Date(), _count: { media: 1, scenarioMedia: 0 } }]);
    const j = await (await GET(new Request("http://x") as never, ctx)).json();
    expect(j.plan).toEqual({ hero: { assetId: U1 }, sections: [{ heading: "売却の進め方", media: null }, { heading: "費用について", media: { kind: "figure", figureKind: "cost_breakdown" } }] });
    expect(j.headings).toEqual(["売却の進め方", "費用について"]);
    expect(j).not.toHaveProperty("frozen");
    expect(j.assets[0]).toMatchObject({ id: U1, referenced: true });
  });

  it("台帳だけが使う写真(scenarioMedia経由)も referenced:true(isAssetReferenced 経由)", async () => {
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1, publicId: "p", mime: "image/jpeg", width: 1, height: 1, bytes: 1, label: null, createdAt: new Date(), _count: { media: 0, scenarioMedia: 1 } }]);
    const j = await (await GET(new Request("http://x") as never, ctx)).json();
    expect(j.assets[0]).toMatchObject({ id: U1, referenced: true });
  });

  it("削除済み/存在しない → 404 SCENARIO_NOT_FOUND", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(null);
    const res = await GET(new Request("http://x") as never, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("管理者以外は 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await GET(new Request("http://x") as never, ctx);
    expect(res.status).toBe(403);
  });
});

describe("PUT /scenarios/[id]/media(台帳の写真と図の保存)", () => {
  it("ロック順は dm_scenarios FOR UPDATE → dm_lp_assets FOR UPDATE", async () => {
    const res = await put(okPlan);
    expect(res.status).toBe(200);
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("dm_scenarios");
    const lastIdx = pm.$queryRaw.mock.calls.length - 1;
    expect(String(pm.$queryRaw.mock.calls[lastIdx][0])).toContain("dm_lp_assets");
    expect(pm.$queryRaw.mock.invocationCallOrder[lastIdx]).toBeLessThan(pm.dmScenarioMedia.deleteMany.mock.invocationCallOrder[0]);
  });

  it("行を入れ替えて保存し、監査に件数だけ残す", async () => {
    const res = await put(okPlan);
    expect(res.status).toBe(200);
    expect(pm.dmScenarioMedia.deleteMany.mock.calls[0][0].where).toEqual({ scenarioId: SID });
    const rows = pm.dmScenarioMedia.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      { scenarioId: SID, slot: "hero", heading: null, assetId: U1, figureKind: null, sortOrder: 0 },
      { scenarioId: SID, slot: "section", heading: "売却の進め方", assetId: null, figureKind: "sale_flow", sortOrder: 1 },
      { scenarioId: SID, slot: "section", heading: "費用について", assetId: U2, figureKind: null, sortOrder: 2 },
    ]);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "sale_dm_scenario_media_update", targetTable: "dm_scenarios", targetId: SID, detail: { assetCount: 2, figureCount: 1 } });
    expect(JSON.stringify(writeAuditLog.mock.calls[0][0].detail)).not.toContain("売却の進め方");
  });

  it("本文に無い小見出しは 400 INVALID_MEDIA_PLAN", async () => {
    const res = await put({ hero: null, sections: [{ heading: "無い", media: null }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_MEDIA_PLAN");
    expect(pm.dmScenarioMedia.deleteMany).not.toHaveBeenCalled();
  });

  it("削除済みの写真は 422 ASSET_NOT_FOUND(発送版のlp-variants/[lpId]/mediaと同じ状態・コード)", async () => {
    pm.dmLpAsset.findMany.mockResolvedValue([{ id: U1 }]);
    const res = await put(okPlan);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("ASSET_NOT_FOUND");
    expect(pm.dmScenarioMedia.deleteMany).not.toHaveBeenCalled();
  });

  it("本文が未保存(空)のときは保存できない(409 TEMPLATE_MISSING)", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ lpBodyText: null }));
    const res = await put({ hero: { assetId: U1 }, sections: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("TEMPLATE_MISSING");
  });

  it("削除済み/存在しない台帳 → 404 SCENARIO_NOT_FOUND・保存しない", async () => {
    pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: new Date() }]);
    const res = await put(okPlan);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
    expect(pm.dmScenarioMedia.deleteMany).not.toHaveBeenCalled();
  });

  it("管理者以外は 403・処理に入らない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await put(okPlan);
    expect(res.status).toBe(403);
    expect(pm.dmScenarioMedia.deleteMany).not.toHaveBeenCalled();
  });
});

describe("GET /scenarios/[id]/preview(台帳のLP社内プレビュー)", () => {
  it("LPの文面が無い → 404 LP_NOT_READY", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ lpBodyText: null }));
    const res = await PREVIEW(new Request("http://x") as never, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("LP_NOT_READY");
  });

  it("見出しが無い場合も LP_NOT_READY", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ lpHeadline: null }));
    const res = await PREVIEW(new Request("http://x") as never, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("LP_NOT_READY");
  });

  it("文面があれば 200・text/html・LP_PAGE_HEADERS付き・見本住所や氏名は出ない・プレビュー帯が出る", async () => {
    const res = await PREVIEW(new Request("http://x") as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain("プレビュー");
    // 台帳には宛先が無い=所在は常にフォールバック文言(見本住所・番地は出ない)。
    expect(html).toContain("ご所有の物件の周辺");
    expect(html).not.toContain("1-2-3");
    // 送付前・社内プレビューでは計測(電話タップ)と申込送信のスクリプトを出さない。出るのは動きのスクリプト(2026-10-08)だけ
    expect(html).not.toContain("sendBeacon");
    expect(html).not.toContain("fetch(f.action");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    expect(html).toContain('classList.add("anim")');
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      action: "sale_dm_scenario_lp_preview_view",
      targetTable: "dm_scenarios",
      targetId: SID,
      detail: expect.objectContaining({ device: "sp" }),
    });
  });

  it("削除済み/存在しない → 404 SCENARIO_NOT_FOUND", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(null);
    const res = await PREVIEW(new Request("http://x") as never, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("device=pc も通り、監査にpcが残る", async () => {
    const res = await PREVIEW(new Request("http://x/?device=pc") as never, ctx);
    expect(res.status).toBe(200);
    expect(writeAuditLog.mock.calls[0][0].detail.device).toBe("pc");
  });

  it("管理者以外は 403(台帳の中身は管理者だけ)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await PREVIEW(new Request("http://x") as never, ctx);
    expect(res.status).toBe(403);
  });
});

describe("GET /scenarios/[id]/image-prompt(台帳の画像の指示文)", () => {
  const q = (qs: string) => PROMPT(new Request(`http://x/?${qs}`) as never, ctx);

  it("propertyKind は常に null(台帳には宛先が無い)・appeal は lpAppeal から", async () => {
    const j = await (await q("slot=hero&style=photo")).json();
    expect(j.prompt).toContain("16:9");
    expect(j.prompt).toContain("相続");
    expect(j.prompt).not.toContain("お持ちの方が"); // propertyKind=null なので種別入りの文言は出ない
    expect(j.prompt).toContain("所有者の方が");
  });

  it("節用: 見出しは本文の何番目かに変換される", async () => {
    const r = await q("slot=section&heading=" + encodeURIComponent("費用について"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.prompt).toContain("2 番目");
    expect(j.prompt).toContain("全 2 節");
    expect(j.prompt).not.toContain("費用について");
  });

  it("本文に無い小見出しは 400 HEADING_NOT_FOUND", async () => {
    const r = await q("slot=section&heading=" + encodeURIComponent("無い"));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("HEADING_NOT_FOUND");
  });

  it("LPの訴求(lpAppeal)が未設定 → 400 SCENARIO_SETTINGS_INCOMPLETE", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ lpAppeal: null }));
    const r = await q("slot=hero");
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("SCENARIO_SETTINGS_INCOMPLETE");
  });

  it("削除済み/存在しない → 404 SCENARIO_NOT_FOUND", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(null);
    const r = await q("slot=hero");
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("管理者以外は 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const r = await q("slot=hero");
    expect(r.status).toBe(403);
  });
});
