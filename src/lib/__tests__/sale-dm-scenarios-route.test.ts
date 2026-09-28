import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/generated/prisma", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));
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
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmScenario: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
      aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
      count: vi.fn(async () => 0),
    },
    dmScenarioMedia: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    property: { count: vi.fn(async () => 0) },
    dmCampaign: { count: vi.fn(async () => 0) },
    dmVariant: { count: vi.fn(async () => 0) },
    dmLpVariant: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => [{ id: "s1", deleted_at: null }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET as LIST, POST } from "../../app/api/properties/sale-dm/scenarios/route";
import { GET as OPTIONS_LIST } from "../../app/api/properties/sale-dm/scenarios/options/route";
import { GET as GET_ONE, PATCH, DELETE } from "../../app/api/properties/sale-dm/scenarios/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmScenario: {
    findMany: Fn; findFirst: Fn; findUnique: Fn; findUniqueOrThrow: Fn;
    create: Fn; update: Fn; aggregate: Fn; count: Fn;
  };
  dmScenarioMedia: { deleteMany: Fn };
  property: { count: Fn };
  dmCampaign: { count: Fn };
  dmVariant: { count: Fn };
  dmLpVariant: { count: Fn };
  $queryRaw: Fn;
};

const SID = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: SID }) };

const scenarioRow = (over: Record<string, unknown> = {}) => ({
  id: SID,
  name: "既存の種類",
  autoKey: null,
  sortOrder: 10,
  active: true,
  designTemplate: "formal",
  tone: "standard",
  length: "medium",
  appeal: "price",
  strength: "medium",
  extraInstruction: null,
  letterPromptText: "指示文",
  letterBodyTemplate: "本文",
  lpTone: "standard",
  lpLength: "medium",
  lpAppeal: "price",
  lpStrength: "medium",
  lpPromptText: "LP指示文",
  lpRawTemplate: "LP原文",
  lpHeadline: "見出し",
  lpLead: "リード",
  lpBodyText: "LP本文",
  lpFaqJson: null,
  deletedAt: null,
  ...over,
});

const req = (method: string, body?: unknown) =>
  new Request("http://x", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    { resource: "user_management", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmScenario.findMany.mockResolvedValue([]);
  pm.dmScenario.findFirst.mockResolvedValue(null);
  pm.dmScenario.findUnique.mockResolvedValue(null);
  pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow());
  pm.dmScenario.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
  pm.dmScenario.update.mockResolvedValue({});
  pm.property.count.mockResolvedValue(0);
  pm.dmCampaign.count.mockResolvedValue(0);
  pm.dmVariant.count.mockResolvedValue(0);
  pm.dmLpVariant.count.mockResolvedValue(0);
  pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: null }]);
});

describe("台帳 API(設計 §3.6・§4)", () => {
  it("一覧(中身あり)は管理者だけ: 管理者以外は 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await LIST();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("選択肢は office_staff(property:write)でも取れ、中身の列を返さない(ready は返す)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    pm.dmScenario.findMany.mockResolvedValue([
      { id: SID, name: "相続", sortOrder: 10, autoKey: "inheritance", letterBodyTemplate: "本文" },
      { id: "s2", name: "空き家", sortOrder: 20, autoKey: null, letterBodyTemplate: null },
    ]);
    const res = await OPTIONS_LIST(new Request("http://x/api/properties/sale-dm/scenarios/options"));
    expect(res.status).toBe(200);
    expect(pm.dmScenario.findMany).toHaveBeenCalledWith({
      where: { active: true, deletedAt: null },
      select: { id: true, name: true, sortOrder: true, autoKey: true, letterBodyTemplate: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const j = await res.json();
    expect(j.scenarios).toHaveLength(2);
    for (const s of j.scenarios) {
      expect(Object.keys(s).sort()).toEqual(["autoKey", "id", "name", "ready", "sortOrder"]);
      expect(s).not.toHaveProperty("letterBodyTemplate");
    }
    expect(j.scenarios[0].ready).toBe(true);
    expect(j.scenarios[1].ready).toBe(false);
  });

  it("選択肢: 物件の閲覧・編集も売却DMの権限も無い → 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    const res = await OPTIONS_LIST(new Request("http://x/api/properties/sale-dm/scenarios/options"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("選択肢: property:read だけ(物件を見られる人)でも 200(名前は機微ではない・物件詳細/変更履歴の表示に要る)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
    const res = await OPTIONS_LIST(new Request("http://x/api/properties/sale-dm/scenarios/options"));
    expect(res.status).toBe(200);
  });

  it("選択肢 ?includeInactive=1: 使わない・削除済みも含め、名前などの見出し情報だけ(中身なし・ready は含む)を返す", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
    pm.dmScenario.findMany.mockResolvedValue([
      { id: SID, name: "相続", sortOrder: 10, autoKey: "inheritance", letterBodyTemplate: "本文", active: true, deletedAt: null },
      { id: "s2", name: "古い種類", sortOrder: 30, autoKey: null, letterBodyTemplate: null, active: false, deletedAt: new Date("2026-09-01") },
    ]);
    const res = await OPTIONS_LIST(new Request("http://x/api/properties/sale-dm/scenarios/options?includeInactive=1"));
    expect(res.status).toBe(200);
    expect(pm.dmScenario.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, sortOrder: true, autoKey: true, letterBodyTemplate: true, active: true, deletedAt: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const j = await res.json();
    expect(j.scenarios).toEqual([
      { id: SID, name: "相続", sortOrder: 10, autoKey: "inheritance", ready: true, active: true, deleted: false },
      { id: "s2", name: "古い種類", sortOrder: 30, autoKey: null, ready: false, active: false, deleted: true },
    ]);
    for (const s of j.scenarios) {
      expect(Object.keys(s).sort()).toEqual(["active", "autoKey", "deleted", "id", "name", "ready", "sortOrder"]);
      expect(s).not.toHaveProperty("letterBodyTemplate");
    }
  });

  it("選択肢: property:write は無いが売却DMの権限(checkSaleDmAccessFor)があれば 200", async () => {
    (getUserPermissions as Fn).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
      { resource: "csv_export", action: "read", granted: true },
      { resource: "csv_export_personal", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await OPTIONS_LIST(new Request("http://x/api/properties/sale-dm/scenarios/options"));
    expect(res.status).toBe(200);
  });

  it("追加: 同じ名前(削除されていない行)=P2002 → 409 NAME_TAKEN", async () => {
    pm.dmScenario.create.mockRejectedValue({ code: "P2002" });
    const res = await POST(req("POST", { name: "既存の種類" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("NAME_TAKEN");
  });

  it("追加: 成功時は監査に result のみ残し、201 で id を返す", async () => {
    pm.dmScenario.create.mockResolvedValue({ id: "new-id" });
    const res = await POST(req("POST", { name: "新しい種類" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).id).toBe("new-id");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "sale_dm_scenario_create",
      targetTable: "dm_scenarios",
      targetId: "new-id",
      detail: { result: "created" },
    }));
  });

  it("PATCH: 先に FOR UPDATE、手紙の設定を変えたら手紙の指示文・原文を消す", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ tone: "formal" }));
    const res = await PATCH(req("PATCH", { tone: "standard" }), ctx);
    expect(res.status).toBe(200);
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("FOR UPDATE");
    const data = pm.dmScenario.update.mock.calls[0][0].data;
    expect(data.letterPromptText).toBeNull();
    expect(data.letterBodyTemplate).toBeNull();
    expect(data.lpPromptText).toBeUndefined();
  });

  it("PATCH: LPの設定を変えたらLPの原文・切り分け・写真と図を消す", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ lpTone: "formal" }));
    const res = await PATCH(req("PATCH", { lpTone: "standard" }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmScenario.update.mock.calls[0][0].data;
    expect(data.lpPromptText).toBeNull();
    expect(data.lpRawTemplate).toBeNull();
    expect(data.lpHeadline).toBeNull();
    expect(data.lpLead).toBeNull();
    expect(data.lpBodyText).toBeNull();
    expect(data.lpFaqJson).toBe(Prisma.DbNull);
    expect(pm.dmScenarioMedia.deleteMany).toHaveBeenCalledWith({ where: { scenarioId: SID } });
  });

  it("PATCH: designTemplate だけ変える → 文面は消さない(外部AIのプロンプトに含まれない項目)", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ designTemplate: "formal" }));
    const res = await PATCH(req("PATCH", { designTemplate: "soft" }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmScenario.update.mock.calls[0][0].data;
    expect(data.designTemplate).toBe("soft");
    expect(data.letterBodyTemplate).toBeUndefined();
    expect(data.letterPromptText).toBeUndefined();
    const j = await res.json();
    expect(j.changedFields).toEqual(["designTemplate"]);
  });

  it("PATCH: extraInstruction だけ変える → 文面は消さない(外部AIのプロンプトに含まれない項目)", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ extraInstruction: null }));
    const res = await PATCH(req("PATCH", { extraInstruction: "季節のあいさつを入れる" }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmScenario.update.mock.calls[0][0].data;
    expect(data.extraInstruction).toBe("季節のあいさつを入れる");
    expect(data.letterBodyTemplate).toBeUndefined();
    expect(data.letterPromptText).toBeUndefined();
    const j = await res.json();
    expect(j.changedFields).toEqual(["extraInstruction"]);
  });

  it("PATCH: name だけ変える → 文面は消さない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ name: "旧名" }));
    const res = await PATCH(req("PATCH", { name: "新名" }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmScenario.update.mock.calls[0][0].data;
    expect(data.name).toBe("新名");
    expect(data.letterBodyTemplate).toBeUndefined();
    expect(data.lpBodyText).toBeUndefined();
    expect(pm.dmScenarioMedia.deleteMany).not.toHaveBeenCalled();
  });

  it("PATCH: extraInstruction の空文字は保存済み null と同義(変化なし)扱いになり、手紙は消えない・空文字のまま保存しない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ name: "旧名", extraInstruction: null }));
    const res = await PATCH(req("PATCH", { name: "新名", extraInstruction: "" }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmScenario.update.mock.calls[0][0].data;
    expect(data.name).toBe("新名");
    expect(data.extraInstruction).toBeNull();
    expect(data.letterBodyTemplate).toBeUndefined();
    expect(data.letterPromptText).toBeUndefined();
    const j = await res.json();
    expect(j.changedFields).toEqual(["name"]);
  });

  it("PATCH: 空白のみの extraInstruction も null 扱い(trim 後に空文字判定)", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ extraInstruction: null }));
    const res = await PATCH(req("PATCH", { extraInstruction: "   " }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.changedFields).toEqual([]);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("PATCH: 送った値が保存値と同じ(no-op) → update を呼ばず、何も消さず、監査もしない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ tone: "standard" }));
    const res = await PATCH(req("PATCH", { tone: "standard" }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.changedFields).toEqual([]);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(pm.dmScenarioMedia.deleteMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("PATCH: 名前の変更で update が P2002 → 409 NAME_TAKEN(監査もしない)", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ name: "旧名" }));
    pm.dmScenario.update.mockRejectedValue({ code: "P2002" });
    const res = await PATCH(req("PATCH", { name: "重複している名前" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("NAME_TAKEN");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("DELETE: 物件(property.dmScenarioId)の参照があれば 409 SCENARIO_IN_USE", async () => {
    pm.property.count.mockResolvedValue(1);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_IN_USE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("DELETE: 発送の既定(dmCampaign.defaultScenarioId)だけでも 409 SCENARIO_IN_USE", async () => {
    pm.dmCampaign.count.mockResolvedValue(1);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_IN_USE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("DELETE: DM型(dmVariant.scenarioId)だけでも 409 SCENARIO_IN_USE", async () => {
    pm.dmVariant.count.mockResolvedValue(1);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_IN_USE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("DELETE: LP型(dmLpVariant.scenarioId)だけでも 409 SCENARIO_IN_USE", async () => {
    pm.dmLpVariant.count.mockResolvedValue(1);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_IN_USE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("DELETE: auto_key の行は 409 SCENARIO_RESERVED", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ autoKey: "inheritance" });
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_RESERVED");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("DELETE: 参照0・autoKey null なら論理削除", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ autoKey: null });
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(pm.dmScenario.update).toHaveBeenCalledWith({
      where: { id: SID },
      data: { deletedAt: expect.any(Date), active: false },
    });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "sale_dm_scenario_delete",
      targetId: SID,
      detail: { result: "deleted" },
    }));
  });

  it("削除済みの行への GET は 404", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(null);
    const res = await GET_ONE(req("GET"), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("削除済みの行への PATCH は 404", async () => {
    pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: new Date() }]);
    const res = await PATCH(req("PATCH", { name: "新名" }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("監査の detail に文面の中身を入れない(changedFields は列名の配列だけ)", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow({ tone: "formal" }));
    await PATCH(req("PATCH", { tone: "standard" }), ctx);
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "u1",
      action: "sale_dm_scenario_update",
      targetTable: "dm_scenarios",
      targetId: SID,
      detail: { changedFields: ["tone"] },
    });
  });
});
