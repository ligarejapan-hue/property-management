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
    dmRecipientDraft: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
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
  dmRecipientDraft: { count: Fn; findMany: Fn };
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
  pm.dmRecipientDraft.findMany.mockResolvedValue([]);
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
    // 呼び出し順: 1回目PATCH = sentBefore(0) → settledCount(1・確定のみ) / 2回目PATCH(label のみ) = sentBefore(0)。
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
  it("dm_lp_variants 行 → この型の宛先行 の順に FOR UPDATE でロックしてから判定する", async () => {
    await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    const sql = sqlCalls();
    expect(sql.join("\n")).toMatch(/FROM dm_lp_variants[\s\S]*FOR UPDATE/);
    // ⚠ラベルだけの変更は宛先行に触れない=行ロックが無いと mark-sent と直列化されず、
    //   「送付済み0件」と数えた直後の送付確定を見落とす(@codex R2 P2)。
    const l = sql.findIndex((s) => /FROM dm_lp_variants[\s\S]*FOR UPDATE/.test(s));
    const d = sql.findIndex((s) => /FROM dm_recipient_drafts[\s\S]*FOR UPDATE/.test(s));
    expect(l).toBeGreaterThan(-1);
    expect(d).toBeGreaterThan(l);
  });
  it("label だけの変更でも宛先行をロックする(送付確定との競合を検出する土台)", async () => {
    await PATCH(req("PATCH", { label: "B" }), ctxLp);
    expect(sqlCalls().some((s) => /FROM dm_recipient_drafts[\s\S]*FOR UPDATE/.test(s))).toBe(true);
  });
  it("更新後に送付確定が入っていたら 409 VARIANT_LOCKED(sentAfter)", async () => {
    // 呼び出し順: sentBefore(0) → settledCount(0) → update → sentAfter(1)。
    // ロックの内側でも念のため後ろでも数える(DM型の PATCH と同じ二重の備え)。
    pm.dmRecipientDraft.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const res = await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_LOCKED");
    // update は呼ばれるが tx 全体がロールバックされる(mock では例外の送出で表す)。
    expect(pm.dmLpVariant.update).toHaveBeenCalled();
  });
  it("field_staff は担当外の宛先が居ると文体を変えられない(403・何も消さない)", async () => {
    // 設定変更はこの型の原文・切り分け結果を消す=担当外(再割当で隠れた)宛先のLP表示まで白紙にする。
    // ⚠count は複数回(担当外の件数 / sentBefore / settledCount …)呼ばれるが、`Once` の並びで
    //   組むと実装が1回呼ばなくなっただけで余りが次のテストへ漏れる。where の形で答えを決める。
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.count.mockImplementation(async (args: { where?: { property?: unknown } }) =>
      args?.where?.property ? 1 : 0,
    );
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p-hidden" }]);
    const res = await PATCH(req("PATCH", { options: { tone: "soft" } }), ctxLp);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(pm.dmLpVariant.update).not.toHaveBeenCalled();
    // 担当外の判定は NOT(OR) で行う(assignedTo が NULL の未割当物件も担当外として数える)。
    // ⚠呼び出し番号で指すと並べ替えのたびに落ちる。where の形で当該の count を探す。
    const scopeCall = pm.dmRecipientDraft.count.mock.calls.find(
      (c) => (c[0] as { where?: { property?: unknown } } | undefined)?.where?.property,
    ) as [{ where: { property: unknown } }] | undefined;
    expect(scopeCall?.[0].where.property).toEqual({
      NOT: { OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] },
    });
    // 物件親行のロックは dm_lp_variants の後(ロック順序)。403 で止まるので宛先行までは行かない。
    const sql = sqlCalls();
    expect(sql[0]).toMatch(/dm_lp_variants/);
    expect(sql[1]).toMatch(/FROM properties[\s\S]*FOR UPDATE/);
  });
  it("field_staff でも label だけなら物件親行を掴まずに 200(何も消えないため)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p-hidden" }]);
    const res = await PATCH(req("PATCH", { label: "B" }), ctxLp);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.findMany).not.toHaveBeenCalled();
    expect(sqlCalls().join("\n")).not.toMatch(/FROM properties/);
    expect(pm.dmLpVariant.update.mock.calls[0][0].data).toEqual({ label: "B" });
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
