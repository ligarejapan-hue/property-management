/**
 * 発送の作成(POST /api/properties/sale-dm/campaigns)の「DMの種類」つきの道
 * (設計 2026-09-27-sale-dm-scenarios-design.md §3.3・§3.3.0・§3.3.1・§4)。
 * 既定の種類を送ったときだけ、宛先ごとに種類の手紙の型とLPの型を組で付け、本文を差し込む。
 * 送らない作成は今までと同じ(既存の sale-dm-campaigns-route.test.ts がそのまま緑)。
 */
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
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR", message: String(e) } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

const m = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("FROM owners")) calls.push("lock:owners");
      else if (sql.includes("FROM properties")) calls.push("lock:properties");
      else if (sql.includes("FROM dm_scenarios")) calls.push("lock:dm_scenarios");
      else calls.push(`raw:${sql}`);
      return [];
    }),
    txPropertyFindMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
    scenarioFindMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
    propertyOwnerFindMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
    dmLogFindMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
    variantCreate: vi.fn(async (a: { data: { label: string } }) => ({ id: `v-${a.data.label}` })),
    variantFindFirst: vi.fn(async (_a?: unknown) => null),
    lpCreate: vi.fn(async (a: { data: { label: string } }) => ({ id: `lp-${a.data.label}` })),
    lpFindFirst: vi.fn(async (_a?: unknown) => null),
    mediaFindMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
    lpMediaCreateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
    draftCreate: vi.fn(async (_a?: unknown) => ({ id: "d1" })),
    draftOwnerCreateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
    campaignUpdate: vi.fn(async (_a?: unknown) => ({})),
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    dmCampaign: { create: vi.fn(async () => ({ id: "c1" })), findUnique: vi.fn(async () => null), delete: vi.fn(async () => ({ id: "deleted" })), deleteMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      $queryRaw: m.queryRaw,
      property: { findMany: (a: unknown) => { m.calls.push("tx:property.findMany"); return m.txPropertyFindMany(a); } },
      dmScenario: { findMany: (a: unknown) => { m.calls.push("tx:dmScenario.findMany"); return m.scenarioFindMany(a); } },
      propertyOwner: { findMany: (a: unknown) => { m.calls.push("tx:propertyOwner.findMany"); return m.propertyOwnerFindMany(a); } },
      propertyDmLog: { findMany: m.dmLogFindMany },
      dmVariant: { create: m.variantCreate, findFirst: m.variantFindFirst },
      dmLpVariant: { create: m.lpCreate, findFirst: m.lpFindFirst },
      dmScenarioMedia: { findMany: m.mediaFindMany },
      dmLpVariantMedia: { createMany: m.lpMediaCreateMany },
      dmRecipientDraft: { create: m.draftCreate },
      dmRecipientDraftOwner: { createMany: m.draftOwnerCreateMany },
      dmCampaign: { update: m.campaignUpdate },
    })),
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST } from "../../app/api/properties/sale-dm/campaigns/route";

const pm = prismaMock as never as {
  property: { findMany: ReturnType<typeof vi.fn> };
  dmCampaign: { create: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
};

const S_INH = "aaaaaaaa-0000-4000-8000-000000000001";
const S_VAC = "aaaaaaaa-0000-4000-8000-000000000002";
const TEMPLATE_INH = "{{物件所在}}の{{物件種別}}について(相続)";
const TEMPLATE_VAC = "{{物件所在}}の{{物件種別}}について(空き家)";

const scenario = (over: Record<string, unknown>) => ({
  id: S_INH, name: "相続", autoKey: "inheritance", active: true, deletedAt: null,
  designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low",
  extraInstruction: null, letterPromptText: "p", letterBodyTemplate: TEMPLATE_INH,
  lpTone: "formal", lpLength: "medium", lpAppeal: "price", lpStrength: "low",
  lpPromptText: "lp", lpRawTemplate: "raw", lpHeadline: "見出し", lpLead: "リード", lpBodyText: "本文", lpFaqJson: null,
  ...over,
});
const inheritance = scenario({});
// LP の文面なし=手紙だけの種類。
const vacant = scenario({ id: S_VAC, name: "空き家", autoKey: "vacant", letterBodyTemplate: TEMPLATE_VAC, lpHeadline: null, lpBodyText: null });

const own = (id: string, addr: string) => ({
  isPrimary: true, relationship: null,
  owner: { id, name: `名${id}`, nameKana: null, zip: "1000001", address: addr, currentZip: null, currentAddress: null, corporateNumber: null },
});
const preProp = (id: string, ownerId: string) => ({
  id, address: `東京都杉並区西荻北${id}`, propertyType: "land", roomNo: null, propertyOwners: [own(ownerId, `東京都${ownerId}町1-1`)],
});
const fresh = (id: string, over: Record<string, unknown> = {}) => ({
  id, address: "東京都杉並区西荻北3-19-4", propertyType: "land", dmScenarioId: null, introductionRoute: "reception_csv",
  createdBy: "u1", assignedTo: null, ...over,
});

const grantAll = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
  ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: true })),
  { resource: "property", action: "write", granted: true },
]);
const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const baseBody = { name: "テスト", options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" } };

/** 物件3件(受付帳取込×2・現地調査×1)。 */
const setupMixed = () => {
  pm.property.findMany.mockResolvedValue([preProp("p1", "o1"), preProp("p2", "o2"), preProp("p3", "o3")]);
  m.propertyOwnerFindMany.mockResolvedValue([
    { propertyId: "p1", ownerId: "o1" }, { propertyId: "p2", ownerId: "o2" }, { propertyId: "p3", ownerId: "o3" },
  ]);
  m.txPropertyFindMany.mockResolvedValue([
    fresh("p1"), fresh("p2"), fresh("p3", { introductionRoute: "field_survey" }),
  ]);
  m.scenarioFindMany.mockResolvedValue([inheritance, vacant]);
};

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  process.env.SALE_DM_TRACKING_BASE_URL = "https://app.example.com";
  process.env.SALE_DM_LP_URL = "https://lp.example.com";
  process.env.SALE_DM_SENDER_NAME = "△△不動産";
  process.env.SALE_DM_SENDER_CONTACT = "03-0000-0000";
  grantAll();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "admin" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  m.dmLogFindMany.mockResolvedValue([]);
  m.variantFindFirst.mockResolvedValue(null);
  m.lpFindFirst.mockResolvedValue(null);
  m.mediaFindMany.mockResolvedValue([]);
  let n = 0;
  m.draftCreate.mockImplementation(async () => ({ id: `d${++n}` }));
});

type DraftData = { propertyId: string; variantId: string; lpVariantId?: string | null; body: string };
const draftData = () => m.draftCreate.mock.calls.map((c) => (c[0] as { data: DraftData }).data);

describe("既定の種類なし=今までと同じ", () => {
  it("台帳を1度も問い合わせず・型は A 1つ・LP型なし・3キーは 0/[]/{}", async () => {
    setupMixed();
    const res = await POST(req(baseBody) as never);
    expect(res.status).toBe(200);
    expect(m.calls).not.toContain("lock:dm_scenarios");
    expect(m.calls).not.toContain("tx:dmScenario.findMany");
    expect(m.calls).not.toContain("tx:property.findMany");
    expect(m.variantCreate).toHaveBeenCalledTimes(1);
    expect((m.variantCreate.mock.calls[0][0] as { data: { label: string } }).data.label).toBe("A");
    expect(m.lpCreate).not.toHaveBeenCalled();
    for (const d of draftData()) {
      expect(d.variantId).toBe("v-A");
      expect("lpVariantId" in d).toBe(false);
      expect(d.body).toBe("");
    }
    const json = await res.json();
    expect(json.blankBodyCount).toBe(0);
    expect(json.lpMissingScenarios).toEqual([]);
    expect(json.scenarioCounts).toEqual({});
    const claim = pm.dmCampaign.create.mock.calls[0][0] as { data: { defaultScenarioId: unknown } };
    expect(claim.data.defaultScenarioId).toBeNull();
  });
});

describe("既定の種類つき", () => {
  it("混在: 相続(手紙+LP)×2・空き家(手紙のみ)×1 が組で付く", async () => {
    setupMixed();
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(200);
    expect(m.variantCreate).toHaveBeenCalledTimes(2);
    const labels = m.variantCreate.mock.calls.map((c) => (c[0] as { data: { label: string; scenarioId: string } }).data);
    expect(labels.map((l) => l.label).sort()).toEqual(["相続", "空き家"].sort());
    expect(labels.every((l) => l.scenarioId === S_INH || l.scenarioId === S_VAC)).toBe(true);
    expect(labels.some((l) => l.label === "A")).toBe(false);
    expect(m.lpCreate).toHaveBeenCalledTimes(1);
    const byProp = Object.fromEntries(draftData().map((d) => [d.propertyId, d]));
    expect(byProp.p1).toMatchObject({ variantId: "v-相続", lpVariantId: "lp-相続" });
    expect(byProp.p2).toMatchObject({ variantId: "v-相続", lpVariantId: "lp-相続" });
    expect(byProp.p3).toMatchObject({ variantId: "v-空き家", lpVariantId: null });
    expect(byProp.p1.body).toBe("東京都杉並区西荻北の土地について(相続)");
    expect(byProp.p3.body).toBe("東京都杉並区西荻北の土地について(空き家)");
    const json = await res.json();
    expect(json.lpMissingScenarios).toEqual(["空き家"]);
    expect(json.scenarioCounts).toEqual({ 相続: 2, 空き家: 1 });
    expect(json.blankBodyCount).toBe(0);
    // 冪等の控えにも同じ3つ。
    const upd = m.campaignUpdate.mock.calls[0][0] as { data: { filterSnapshot: { __result: Record<string, unknown> } } };
    expect(upd.data.filterSnapshot.__result).toMatchObject({ blankBodyCount: 0, lpMissingScenarios: ["空き家"], scenarioCounts: { 相続: 2, 空き家: 1 } });
    // 監査: 使った種類の数と差し込めなかった件数(文面は入れない)。
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as { detail: Record<string, unknown> };
    expect(audit.detail.scenarioCount).toBe(2);
    expect(audit.detail.blankBodyCount).toBe(0);
  });

  it("順序: 所有者 FOR SHARE → 物件 FOR SHARE → 物件の読み直し → 台帳 FOR SHARE → 台帳の読み込み", async () => {
    setupMixed();
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(200);
    const order = ["lock:owners", "lock:properties", "tx:property.findMany", "lock:dm_scenarios", "tx:dmScenario.findMany"];
    const idx = order.map((c) => m.calls.indexOf(c));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const sel = (m.txPropertyFindMany.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    for (const k of ["dmScenarioId", "introductionRoute", "address", "propertyType", "createdBy", "assignedTo"]) {
      expect(sel[k], k).toBe(true);
    }
  });

  it("ロック後に読み直した値を使う(事前は現地調査・読み直しで物件の欄=相続・住所も読み直し)", async () => {
    pm.property.findMany.mockResolvedValue([preProp("p1", "o1")]);
    m.propertyOwnerFindMany.mockResolvedValue([{ propertyId: "p1", ownerId: "o1" }]);
    m.txPropertyFindMany.mockResolvedValue([
      fresh("p1", { introductionRoute: "field_survey", dmScenarioId: S_INH, address: "大阪府大阪市北区梅田1-1-1" }),
    ]);
    m.scenarioFindMany.mockResolvedValue([inheritance, vacant]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_VAC }) as never);
    expect(res.status).toBe(200);
    const [d] = draftData();
    expect(d.variantId).toBe("v-相続");
    expect(d.body).toContain("大阪府大阪市北区");
  });

  it("既定の種類がロック後に使わない → 409 SCENARIO_UNAVAILABLE・宛先を作らない・claim を消す", async () => {
    setupMixed();
    m.scenarioFindMany.mockResolvedValue([scenario({ active: false }), vacant]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_UNAVAILABLE");
    expect(m.draftCreate).not.toHaveBeenCalled();
    expect(pm.dmCampaign.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("既定の種類が台帳に無い(削除済み) → 409 SCENARIO_UNAVAILABLE", async () => {
    setupMixed();
    m.scenarioFindMany.mockResolvedValue([scenario({ deletedAt: new Date() }), vacant]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_UNAVAILABLE");
  });

  it("手紙の文面が未登録の種類が宛先に出る → 409 SCENARIO_NOT_READY(種類名がメッセージに入る)", async () => {
    setupMixed();
    m.scenarioFindMany.mockResolvedValue([inheritance, scenario({ id: S_VAC, name: "空き家", autoKey: "vacant", letterBodyTemplate: null })]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("SCENARIO_NOT_READY");
    expect(json.error.message).toContain("空き家");
    expect(json.error.message).not.toContain("相続");
    expect(m.variantCreate).not.toHaveBeenCalled();
    expect(m.draftCreate).not.toHaveBeenCalled();
  });

  it("物件の欄が指す id が台帳に無い → 409 PROPERTY_SCENARIO_MISSING(既定に落とさない)", async () => {
    setupMixed();
    m.txPropertyFindMany.mockResolvedValue([
      fresh("p1", { dmScenarioId: "aaaaaaaa-0000-4000-8000-00000000dead" }), fresh("p2"), fresh("p3"),
    ]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("PROPERTY_SCENARIO_MISSING");
    expect(m.draftCreate).not.toHaveBeenCalled();
  });

  it("差し込めない宛先(住所 null)は本文を空で作り blankBodyCount に数える・作成は成功", async () => {
    setupMixed();
    m.txPropertyFindMany.mockResolvedValue([fresh("p1", { address: null }), fresh("p2"), fresh("p3", { propertyType: null })]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(200);
    const byProp = Object.fromEntries(draftData().map((d) => [d.propertyId, d]));
    expect(byProp.p1.body).toBe("");
    expect(byProp.p2.body).not.toBe("");
    expect(byProp.p3.body).toBe(""); // 物件種別なし
    const json = await res.json();
    expect(json.blankBodyCount).toBe(2);
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as { detail: Record<string, unknown> };
    expect(audit.detail.blankBodyCount).toBe(2);
  });

  it("field_staff: 読み直しで担当外になった物件がある → 409 RECIPIENTS_CHANGED", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    setupMixed();
    m.txPropertyFindMany.mockResolvedValue([fresh("p1"), fresh("p2", { createdBy: "other", assignedTo: "other" }), fresh("p3")]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("RECIPIENTS_CHANGED");
    expect(m.draftCreate).not.toHaveBeenCalled();
    expect(m.calls).not.toContain("lock:dm_scenarios");
  });

  it("field_staff: 担当(assignedTo)のままなら作れる", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    setupMixed();
    m.txPropertyFindMany.mockResolvedValue([fresh("p1"), fresh("p2", { createdBy: "other", assignedTo: "u1" }), fresh("p3")]);
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH }) as never);
    expect(res.status).toBe(200);
  });

  it("大文字の uuid は小文字で claim に保存する", async () => {
    setupMixed();
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH.toUpperCase() }) as never);
    expect(res.status).toBe(200);
    const claim = pm.dmCampaign.create.mock.calls[0][0] as { data: { defaultScenarioId: unknown } };
    expect(claim.data.defaultScenarioId).toBe(S_INH);
  });

  it("冪等の再送: ready 済みの控えに3キーがあれば応答に出る", async () => {
    pm.dmCampaign.findUnique.mockResolvedValueOnce({
      id: "c9", createdBy: "u1", status: "ready", createdAt: new Date().toISOString(),
      filterSnapshot: { __result: { saved: 3, blankBodyCount: 1, lpMissingScenarios: ["空き家"], scenarioCounts: { 相続: 2, 空き家: 1 } } },
    });
    const res = await POST(req({ ...baseBody, defaultScenarioId: S_INH, idempotencyKey: "k-1" }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.idempotent).toBe(true);
    expect(json.blankBodyCount).toBe(1);
    expect(json.lpMissingScenarios).toEqual(["空き家"]);
    expect(json.scenarioCounts).toEqual({ 相続: 2, 空き家: 1 });
  });
});

describe("監査の許可リスト", () => {
  it("sale_dm_campaign_create の scenarioCount/blankBodyCount は伏せずに残る", async () => {
    const { sanitizeAuditDetail } = await import("../audit-log-detail-safety");
    const out = sanitizeAuditDetail("sale_dm_campaign_create", { campaignId: "c", scenarioCount: 2, blankBodyCount: 1 }) as Record<string, unknown>;
    expect(out.scenarioCount).toBe(2);
    expect(out.blankBodyCount).toBe(1);
  });
});
