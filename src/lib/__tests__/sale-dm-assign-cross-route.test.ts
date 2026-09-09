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
    // 物件親行をロックしたあとの担当範囲の読み直し(@codex R2 P1)。
    property: { findMany: vi.fn(async () => []) },
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
  property: { findMany: Fn };
  $queryRaw: Fn;
};
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1" }) };
const post = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) }) as never;
const prop = { createdBy: "u1", assignedTo: null };
const sqlCalls = () => pm.$queryRaw.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join("?") : String(c[0])));
// ロックの下での読み直し(targetsPost)。テストごとに差し替えて「途中で動いた」状況を作る。
type Post = { variantId: string; lpVariantId: string | null; status: string };
let targetsPost: Post[] = [];

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
  // ⚠`Once` の並びで組まない。途中で 403/409 に落ちるテストが余りを残し、次のテストの
  //   1回目の読みがその余りになる(先読みの結果が別物になって落ちる)。読みの形で答えを決める。
  //   ①先読み(tx外・property を select)②移動元の型+物件(sourcesPre = propertyId を select)
  //   ③ロックの下の読み直し(targetsPost = status を select・凍結の元にもなる)。
  targetsPost = [
    { variantId: "d0", lpVariantId: null, status: "draft" },
    { variantId: "d0", lpVariantId: "l0", status: "draft" },
    { variantId: "d1", lpVariantId: "l1", status: "confirmed" },
  ];
  pm.dmRecipientDraft.findMany.mockImplementation(
    async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      if (args?.select?.property) {
        return [{ id: "r0", property: prop }, { id: "r1", property: prop }, { id: "r2", property: prop }, { id: "r3", property: prop }];
      }
      if (args?.select?.status) return targetsPost;
      return [
        { variantId: "d0", lpVariantId: null, propertyId: "p1" },
        { variantId: "d0", lpVariantId: "l0", propertyId: "p2" },
        // 確定済みの移動元(d1/l1)も先読みで見えている=ロック集合に入る。
        { variantId: "d1", lpVariantId: "l1", propertyId: "p2" },
      ];
    },
  );
  // 既定は「ロックの下でも全件見える」(admin/office はそもそも読み直さない)。
  pm.property.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
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
      expect(c.where).toMatchObject({ campaignId: "c1", status: { not: "sent" } });
      expect(c.where.OR).toEqual([{ lpVariantId: null }, { lpVariantId: { not: c.data.lpVariantId } }]);
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
  it("移動元の LP型(確定/送付済み)へ凍結印を立て、ロックは dm_variants → dm_lp_variants → properties の順", async () => {
    await assign(post({ mode: "auto" }), ctx);
    expect(pm.dmLpVariant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["l1"] }, templateFrozenAt: null } }));
    const sql = sqlCalls();
    const v = sql.findIndex((s) => /dm_variants/.test(s) && !/dm_lp_variants/.test(s));
    const l = sql.findIndex((s) => /dm_lp_variants/.test(s));
    const p = sql.findIndex((s) => /FROM properties/.test(s));
    expect(v).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(v);
    // 物件親行は admin/office でも掴む(確定・反響の書き手と取得順をそろえる)。
    expect(p).toBeGreaterThan(l);
  });

  it("先読みのあとに別の割当が下書きを掴んでいない LP型へ移していたら 409・1件も書き換えず凍結印も立てない", async () => {
    // ロックの下で読み直すと移動元が l9(ロック集合の外)。そのまま凍結印を立てると
    // **ロックしていない dm_lp_variants 行**を properties ロックの後に書き換える=取得順が逆になる。
    targetsPost = [{ variantId: "d0", lpVariantId: "l9", status: "confirmed" }];
    const res = await assign(post({ mode: "auto" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_CHANGED");
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    expect(pm.dmVariant.updateMany).not.toHaveBeenCalled();
    expect(pm.dmLpVariant.updateMany).not.toHaveBeenCalled();
    // 物件ロックまで進まない(=読み直しは dm_lp_variants ロックの直後)。
    expect(sqlCalls().some((s) => /FROM properties/.test(s))).toBe(false);
  });

  it("読み直しで移動元が掴んでいない DM型に変わっていても 409", async () => {
    targetsPost = [{ variantId: "d9", lpVariantId: null, status: "draft" }];
    const res = await assign(post({ mode: "auto" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_CHANGED");
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("担当が変わって見えなくなった物件の宛先が含まれると field_staff は 403・1件も書き換えない", async () => {
    // 先読み(:32 の scope 絞り込み)を通った宛先でも、ロックの下で読み直すと p2 が担当外に
    // なっている=そのまま進めると自分に見えない宛先の型・本文まで書き換わる(@codex R2 P1)。
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.property.findMany.mockResolvedValue([{ id: "p1" }]);
    const res = await assign(post({ mode: "auto" }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    expect(pm.dmVariant.updateMany).not.toHaveBeenCalled();
    expect(pm.dmLpVariant.updateMany).not.toHaveBeenCalled();
    // 読み直しは物件親行のロックの後(ロック順序)。
    const sql = sqlCalls();
    expect(sql[sql.length - 1]).toMatch(/FROM properties[\s\S]*FOR UPDATE/);
  });

  it("field_staff でもロックの下で全件見えていれば通常どおり割り当てる(可視条件は createdBy OR assignedTo)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
    const res = await assign(post({ mode: "auto" }), ctx);
    expect(res.status).toBe(200);
    expect(pm.property.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ["p1", "p2"] },
      OR: [{ createdBy: "u1" }, { assignedTo: "u1" }],
    });
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

  it("manual で lpVariantId: null は割当なしに戻す updateMany を発行する(@codex R5)", async () => {
    const res = await assign(post({ mode: "manual", lpAssignments: [{ recipientId: "r2", lpVariantId: null }] }), ctx);
    expect(res.status).toBe(200);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    // 通常のLP軸(型付け)の updateMany は0件(非null指定が無いため)。アンサイン専用の1件のみ。
    const nullCalls = calls.filter((c) => "lpVariantId" in c.data && c.data.lpVariantId === null);
    expect(nullCalls.length).toBe(1);
    expect(nullCalls[0].where).toEqual({
      id: { in: ["r2"] },
      campaignId: "c1",
      status: { not: "sent" },
      lpVariantId: { not: null },
    });
    expect(nullCalls[0].data).toEqual({ lpVariantId: null });
    const j = await res.json();
    expect(j.perLpVariant).toHaveProperty("__none__");
  });
});
