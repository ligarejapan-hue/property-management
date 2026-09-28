/**
 * 「種類を変える」(POST /api/properties/sale-dm/campaigns/[id]/properties/[propertyId]/scenario)
 * (設計 2026-09-27-sale-dm-scenarios-design.md §3.3.0・§3.3.1・§3.4)。
 * 物件単位で宛先を全員まとめて別の種類の手紙+LPへ切り替え、同じ tx で物件の欄・版番号・変更履歴も書く。
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

const C1 = "cccccccc-0000-4000-8000-000000000001";
const P1 = "dddddddd-0000-4000-8000-000000000001";
const S_INH = "aaaaaaaa-0000-4000-8000-000000000001";
const S_VAC = "aaaaaaaa-0000-4000-8000-000000000002";
const U1 = "bbbbbbbb-0000-4000-8000-000000000001";

const m = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    campaignRows: [] as Array<Record<string, unknown>>,
    editLockRows: [] as Array<Record<string, unknown>>,
    scenarioLockRows: [] as Array<Record<string, unknown>>,
    draftsPre: [] as Array<Record<string, unknown>>,
    draftsPost: [] as Array<Record<string, unknown>>,
    letters: [] as Array<Record<string, unknown>>,
    lps: [] as Array<Record<string, unknown>>,
    property: null as Record<string, unknown> | null,
    scenarios: [] as Array<Record<string, unknown>>,
    variantFindFirst: vi.fn(async (_a?: unknown): Promise<{ id: string; bodyTemplate?: string | null } | null> => null),
    lpFindFirst: vi.fn(async (_a?: unknown): Promise<{ id: string } | null> => null),
    variantCreate: vi.fn(async (_a?: unknown) => ({ id: "v-new" })),
    lpCreate: vi.fn(async (_a?: unknown) => ({ id: "lp-new" })),
    variantUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
    lpUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
    draftUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
    propertyUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
    changeLogCreate: vi.fn(async (_a?: unknown) => ({})),
    mediaFindMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
    lpMediaCreateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  };
});

function makeTx() {
  let draftReads = 0;
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("FROM dm_campaigns")) { m.calls.push("lock:dm_campaigns"); return m.campaignRows; }
      if (sql.includes("FROM dm_variants")) { m.calls.push(`lock:dm_variants:${(values[0] as string[]).join(",")}`); return []; }
      if (sql.includes("FROM dm_lp_variants")) { m.calls.push(`lock:dm_lp_variants:${(values[0] as string[]).join(",")}`); return []; }
      if (sql.includes("FROM properties")) { m.calls.push("lock:properties"); return [{ id: P1 }]; }
      if (sql.includes("edit_locks")) { m.calls.push("check:edit_locks"); return m.editLockRows; }
      if (sql.includes("FROM dm_recipient_drafts")) { m.calls.push("lock:dm_recipient_drafts"); return []; }
      if (sql.includes("FROM dm_scenarios")) { m.calls.push("lock:dm_scenarios"); return m.scenarioLockRows; }
      m.calls.push(`raw:${sql}`);
      return [];
    }),
    dmRecipientDraft: {
      findMany: vi.fn(async () => { draftReads += 1; return draftReads === 1 ? m.draftsPre : m.draftsPost; }),
      updateMany: (a: unknown) => { m.calls.push("tx:draft.updateMany"); return m.draftUpdateMany(a); },
    },
    dmVariant: {
      findMany: vi.fn(async () => m.letters),
      findFirst: m.variantFindFirst,
      create: (a: unknown) => { m.calls.push("tx:variant.create"); return m.variantCreate(a); },
      updateMany: (a: unknown) => { m.calls.push("tx:variant.freeze"); return m.variantUpdateMany(a); },
    },
    dmLpVariant: {
      findMany: vi.fn(async () => m.lps),
      findFirst: m.lpFindFirst,
      create: (a: unknown) => { m.calls.push("tx:lp.create"); return m.lpCreate(a); },
      updateMany: (a: unknown) => { m.calls.push("tx:lp.freeze"); return m.lpUpdateMany(a); },
    },
    dmScenario: { findMany: vi.fn(async () => m.scenarios) },
    dmScenarioMedia: { findMany: m.mediaFindMany },
    dmLpVariantMedia: { createMany: m.lpMediaCreateMany },
    property: {
      findUnique: vi.fn(async () => { m.calls.push("tx:property.findUnique"); return m.property; }),
      updateMany: (a: unknown) => { m.calls.push("tx:property.updateMany"); return m.propertyUpdateMany(a); },
    },
    changeLog: { create: (a: unknown) => { m.calls.push("tx:changeLog.create"); return m.changeLogCreate(a); } },
  };
}

vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(makeTx())),
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { hashScreenToken } from "@/lib/edit-lock/screen-token";
import { POST } from "../../app/api/properties/sale-dm/campaigns/[id]/properties/[propertyId]/scenario/route";

const pm = prismaMock as never as { dmCampaign: { findFirst: ReturnType<typeof vi.fn> } };

const scenario = (over: Record<string, unknown>) => ({
  id: S_INH, name: "相続", autoKey: "inheritance", active: true, deletedAt: null,
  designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low",
  extraInstruction: null, letterPromptText: "p", letterBodyTemplate: "{{物件所在}}の{{物件種別}}について(相続)",
  lpTone: "formal", lpLength: "medium", lpAppeal: "price", lpStrength: "low",
  lpPromptText: "lp", lpRawTemplate: "raw", lpHeadline: "見出し", lpLead: "リード", lpBodyText: "本文", lpFaqJson: null,
  ...over,
});
const inheritance = scenario({});
// 移り先=空き家(LPの文面なし=手紙だけの種類)。
const vacant = scenario({ id: S_VAC, name: "空き家", autoKey: "vacant", letterBodyTemplate: "{{物件所在}}の{{物件種別}}について(空き家)", lpHeadline: null, lpBodyText: null });

const grant = (write = true) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
  ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: true })),
  ...(write ? [{ resource: "property", action: "write", granted: true }] : []),
]);
const req = (b: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(b), headers });
const ctx = (id = C1, propertyId = P1) => ({ params: Promise.resolve({ id, propertyId }) });
const call = (b: unknown = { scenarioId: S_VAC }, headers: Record<string, string> = {}) =>
  POST(req(b, headers) as never, ctx());

/** 相続の組(v-inh / lp-inh)で作られた、共有者2人の物件。 */
function setupTwoOwnersOnInheritance(status: "draft" | "confirmed" = "draft") {
  m.campaignRows = [{ id: C1, default_scenario_id: S_INH, created_by: U1 }];
  m.draftsPre = [
    { variantId: "v-inh", lpVariantId: "lp-inh" },
    { variantId: "v-inh", lpVariantId: "lp-inh" },
  ];
  m.draftsPost = [
    { id: "d1", variantId: "v-inh", lpVariantId: "lp-inh", status },
    { id: "d2", variantId: "v-inh", lpVariantId: "lp-inh", status: "draft" },
  ];
  m.letters = [{ id: "v-inh", scenarioId: S_INH }];
  m.lps = [{ id: "lp-inh", scenarioId: S_INH }];
  m.property = { id: P1, version: 7, dmScenarioId: null, address: "東京都杉並区西荻北3-19-4", propertyType: "land", createdBy: U1, assignedTo: null };
  m.scenarioLockRows = [{ id: S_VAC, active: true, deleted_at: null }];
  m.scenarios = [inheritance, vacant];
  m.draftUpdateMany.mockResolvedValue({ count: 2 });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.editLockRows = [];
  m.variantFindFirst.mockResolvedValue(null);
  m.lpFindFirst.mockResolvedValue(null);
  m.variantCreate.mockResolvedValue({ id: "v-new" });
  m.propertyUpdateMany.mockResolvedValue({ count: 1 });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: C1 });
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: U1, role: "admin" });
  grant();
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  setupTwoOwnersOnInheritance();
});

describe("入口の門", () => {
  it("種類なしの発送 → 409 SCENARIO_CAMPAIGN_REQUIRED(何も書かない)", async () => {
    m.campaignRows = [{ id: C1, default_scenario_id: null, created_by: U1 }];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_REQUIRED");
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).not.toHaveBeenCalled();
  });

  it("他人の発送 → 404(assertSaleDmCampaignOwned)", async () => {
    pm.dmCampaign.findFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(pm.dmCampaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: C1, createdBy: U1 } }));
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
  });

  it("物件の編集権限なし → 403", async () => {
    grant(false);
    const res = await call();
    expect(res.status).toBe(403);
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
  });

  it("担当外の物件(field_staff・ロック後の読み直しで判定)→ 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: U1, role: "field_staff" });
    m.property = { ...m.property!, createdBy: "someone-else", assignedTo: "another" };
    const res = await call();
    expect(res.status).toBe(403);
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).not.toHaveBeenCalled();
  });

  it("物件の宛先が0件 → 404 NO_RECIPIENTS", async () => {
    m.draftsPre = [];
    const res = await call();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NO_RECIPIENTS");
  });

  it("1人でも送付済み → 409 SCENARIO_CHANGE_SENT(何も書かない)", async () => {
    m.draftsPost = [{ ...m.draftsPost[0], status: "sent" }, m.draftsPost[1]];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CHANGE_SENT");
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).not.toHaveBeenCalled();
  });

  it("他人が有効な編集中の鍵を持つ → 423 EDIT_LOCKED", async () => {
    m.editLockRows = [{ id: "l1", user_id: "other", screen_token_hash: "x", force_released: false, active: true }];
    const res = await call();
    expect(res.status).toBe(423);
    expect((await res.json()).error.code).toBe("EDIT_LOCKED");
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).not.toHaveBeenCalled();
  });

  it("自分の画面の鍵(同じ合言葉)なら通る", async () => {
    m.editLockRows = [{ id: "l1", user_id: U1, screen_token_hash: hashScreenToken("tok"), force_released: false, active: true }];
    const res = await call({ scenarioId: S_VAC }, { "X-Edit-Screen": "tok" });
    expect(res.status).toBe(200);
  });

  it("移り先がロック後に「使わない」→ 409 SCENARIO_UNAVAILABLE(宛先には何もしない)", async () => {
    m.scenarioLockRows = [{ id: S_VAC, active: false, deleted_at: null }];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_UNAVAILABLE");
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).not.toHaveBeenCalled();
  });

  it("移り先の手紙が未登録 → 409 SCENARIO_NOT_READY(宛先には何もしない・写さない)", async () => {
    m.scenarios = [inheritance, { ...vacant, letterBodyTemplate: null }];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_READY");
    expect(m.variantCreate).not.toHaveBeenCalled();
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
  });

  it("scenarioId が uuid でない → 400 系(書かない)", async () => {
    const res = await call({ scenarioId: "not-a-uuid" });
    expect(res.status).not.toBe(200);
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
  });
});

describe("切り替え", () => {
  it("ロックの順: 発送 → 型(今+移り先)→ LP → 物件 → 編集中の鍵 → 宛先 → 台帳 → 写す → 宛先更新 → 物件の欄 → 履歴", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const idx = (s: string) => m.calls.findIndex((c) => c.startsWith(s));
    const order = [
      "lock:dm_campaigns", "lock:dm_variants", "lock:dm_lp_variants", "lock:properties", "check:edit_locks",
      "lock:dm_recipient_drafts", "lock:dm_scenarios", "tx:variant.create", "tx:draft.updateMany",
      "tx:property.updateMany", "tx:changeLog.create",
    ].map(idx);
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("共有者2人 → 2人とも移り先の組へ・本文は差し込み直し・状態は下書き", async () => {
    const res = await call();
    const json = await res.json();
    expect(json).toEqual({ changedDrafts: 2, blankBodyCount: 0, lpMissing: true });
    const arg = m.draftUpdateMany.mock.calls[0][0] as { where: { id: { in: string[] } }; data: Record<string, unknown> };
    expect(arg.where.id.in).toEqual(["d1", "d2"]);
    expect(arg.data).toMatchObject({ variantId: "v-new", lpVariantId: null, status: "draft", confirmedAt: null });
    expect(String(arg.data.body)).toContain("空き家");
    expect(String(arg.data.body)).not.toContain("{{");
  });

  it("LPのある種類へ → lpVariantId は写した LP・lpMissing=false", async () => {
    // 空き家の発送で、相続(LPあり)へ移す。
    m.campaignRows = [{ id: C1, default_scenario_id: S_VAC, created_by: U1 }];
    m.draftsPre = [{ variantId: "v-vac", lpVariantId: null }];
    m.draftsPost = [{ id: "d1", variantId: "v-vac", lpVariantId: null, status: "draft" }];
    m.letters = [{ id: "v-vac", scenarioId: S_VAC }];
    m.lps = [];
    m.scenarioLockRows = [{ id: S_INH, active: true, deleted_at: null }];
    m.lpCreate.mockResolvedValue({ id: "lp-new" });
    m.draftUpdateMany.mockResolvedValue({ count: 1 });
    const res = await call({ scenarioId: S_INH });
    expect(await res.json()).toEqual({ changedDrafts: 1, blankBodyCount: 0, lpMissing: false });
    const arg = m.draftUpdateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data).toMatchObject({ variantId: "v-new", lpVariantId: "lp-new" });
  });

  it("物件の欄: 読んだ版で条件つき更新・版番号を1進める・変更履歴1行(旧→新)", async () => {
    await call();
    expect(m.propertyUpdateMany).toHaveBeenCalledWith({
      where: { id: P1, version: 7 },
      data: { dmScenarioId: S_VAC, version: { increment: 1 } },
    });
    expect(m.changeLogCreate).toHaveBeenCalledWith({
      data: {
        targetTable: "properties", targetId: P1, fieldName: "dmScenarioId",
        oldValue: null, newValue: S_VAC, source: "manual", changedBy: U1,
      },
    });
  });

  it("版が合わない(0件)→ 409 VERSION_CONFLICT", async () => {
    m.propertyUpdateMany.mockResolvedValue({ count: 0 });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
    expect(m.changeLogCreate).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("確定済みの宛先がいる → 下書きに戻す前に移動元の型へ凍結の印", async () => {
    setupTwoOwnersOnInheritance("confirmed");
    await call();
    expect(m.variantUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["v-inh"] }, templateFrozenAt: null } }));
    expect(m.lpUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["lp-inh"] }, templateFrozenAt: null } }));
    expect(m.calls.indexOf("tx:variant.freeze")).toBeLessThan(m.calls.indexOf("tx:draft.updateMany"));
  });

  it("確定済みがいなければ凍結の印は立てない", async () => {
    await call();
    expect(m.variantUpdateMany).not.toHaveBeenCalled();
    expect(m.lpUpdateMany).not.toHaveBeenCalled();
  });

  it("移り先の写しが既にある → 作らずに既存を使う(findFirst)・その型もロックに入る", async () => {
    m.letters = [{ id: "v-inh", scenarioId: S_INH }, { id: "v-vac", scenarioId: S_VAC }];
    m.variantFindFirst.mockResolvedValue({ id: "v-vac" });
    await call();
    expect(m.variantCreate).not.toHaveBeenCalled();
    expect(m.calls).toContain("lock:dm_variants:v-inh,v-vac");
    expect((m.draftUpdateMany.mock.calls[0][0] as { data: { variantId: string } }).data.variantId).toBe("v-vac");
  });

  it("移り先の写しが既にある → 本文は台帳の今の本文ではなく、その写しの本文から差し込む", async () => {
    m.letters = [{ id: "v-inh", scenarioId: S_INH }, { id: "v-vac", scenarioId: S_VAC }];
    m.variantFindFirst.mockResolvedValue({ id: "v-vac", bodyTemplate: "{{物件所在}}の{{物件種別}}について(写しの本文)" });
    // 台帳は凍結されないので、写した後に書き換わっている。
    m.scenarios = [inheritance, { ...vacant, letterBodyTemplate: "{{物件所在}}の{{物件種別}}について(台帳で書き換えた本文)" }];
    await call();
    const body = (m.draftUpdateMany.mock.calls[0][0] as { data: { body: string } }).data.body;
    expect(body).toContain("(写しの本文)");
    expect(body).not.toContain("台帳で書き換えた本文");
  });

  it("同時に2件来ても写しは1つ(2件目は findFirst で既存を使う)", async () => {
    let created = false;
    m.variantFindFirst.mockImplementation(async () => (created ? { id: "v-new" } : null));
    m.variantCreate.mockImplementation(async () => { created = true; return { id: "v-new" }; });
    await call();
    await call();
    expect(m.variantCreate).toHaveBeenCalledTimes(1);
  });

  it("差し込めない物件(住所・種別なし)→ 本文は空・blankBodyCount に数える", async () => {
    m.property = { ...m.property!, address: null, propertyType: null };
    const res = await call();
    expect(await res.json()).toMatchObject({ changedDrafts: 2, blankBodyCount: 2 });
    expect((m.draftUpdateMany.mock.calls[0][0] as { data: { body: string } }).data.body).toBe("");
  });

  it("監査: sale_dm_scenario_change・件数だけ", async () => {
    await call();
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: U1, action: "sale_dm_scenario_change", targetTable: "properties", targetId: P1,
      detail: { campaignId: C1, propertyId: P1, changedDrafts: 2, blankBodyCount: 0 },
    });
  });

  it("同じ種類への変更 → 何もしない {changedDrafts:0}・監査も書かない", async () => {
    m.property = { ...m.property!, dmScenarioId: S_INH };
    const res = await call({ scenarioId: S_INH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changedDrafts: 0, blankBodyCount: 0, lpMissing: false });
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).not.toHaveBeenCalled();
    expect(m.changeLogCreate).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("宛先は既にその種類・物件の欄だけ違う → 宛先は触らず物件の欄だけ書く", async () => {
    m.scenarioLockRows = [{ id: S_INH, active: true, deleted_at: null }];
    const res = await call({ scenarioId: S_INH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changedDrafts: 0, blankBodyCount: 0, lpMissing: false });
    expect(m.draftUpdateMany).not.toHaveBeenCalled();
    expect(m.variantCreate).not.toHaveBeenCalled();
    expect(m.propertyUpdateMany).toHaveBeenCalledWith({ where: { id: P1, version: 7 }, data: { dmScenarioId: S_INH, version: { increment: 1 } } });
    expect(m.changeLogCreate).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ changedDrafts: 0 }) }));
  });

  it("大文字の scenarioId は小文字にそろえて書く", async () => {
    await call({ scenarioId: S_VAC.toUpperCase() });
    expect(m.propertyUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { dmScenarioId: S_VAC, version: { increment: 1 } } }));
  });
});
