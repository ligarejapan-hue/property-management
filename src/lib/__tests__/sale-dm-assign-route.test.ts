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
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findFirst: vi.fn() },
    dmVariant: { findMany: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST as assign } from "../../app/api/properties/sale-dm/campaigns/[id]/assign/route";

const pm = prismaMock as never as {
  dmCampaign: { findFirst: ReturnType<typeof vi.fn> };
  dmVariant: { findMany: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(ALL.map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })));
const ctxC = { params: Promise.resolve({ id: "c1" }) };
const post = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  // assertSaleDmCampaignOwned 用: 既定で作成者本人のキャンペーン(owned)。
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  pm.dmVariant.findMany.mockResolvedValue([{ id: "vA" }, { id: "vB" }]);
  pm.dmRecipientDraft.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }]);
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 2 });
});

describe("POST assign (auto)", () => {
  it("自動均等割りで型ごとに updateMany を呼び 200", async () => {
    const res = await assign(post({ mode: "auto", order: "sequential" }) as never, ctxC);
    expect(res.status).toBe(200);
    // 2型なので updateMany は最大2回(型ごと)
    expect(pm.dmRecipientDraft.updateMany.mock.calls.length).toBeGreaterThanOrEqual(1);
    const allUpdates = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    // すべて campaignId で縛る
    for (const u of allUpdates) expect(u.where.campaignId).toBe("c1");
    const json = await res.json();
    expect(json.assigned).toBe(4);
  });

  it("送付済み(sent)の宛先は再割当対象から除外する(取得・更新の両方で status!=sent)", async () => {
    const res = await assign(post({ mode: "auto", order: "sequential" }) as never, ctxC);
    expect(res.status).toBe(200);
    // 割当対象の取得時点で sent を除外
    const findArg = pm.dmRecipientDraft.findMany.mock.calls[0][0];
    expect(findArg.where.status).toEqual({ not: "sent" });
    // 更新時も sent を弾く(防御・送付済みの A/B バケットを書き換えない)
    const updates = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    for (const u of updates) expect(u.where.status).toEqual({ not: "sent" });
  });

  it("型を変える宛先は本文をクリア(=要再生成)し、変更分のみに限定する(A/Bコピー不一致の送付防止)", async () => {
    const res = await assign(post({ mode: "auto", order: "sequential" }) as never, ctxC);
    expect(res.status).toBe(200);
    const updates = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    for (const u of updates) {
      expect(u.data.body).toBe("");                          // 不一致になる本文をクリア
      expect(u.data.status).toBe("draft");                   // confirmed のまま空 body にしない(再確定を強制)
      expect(u.data.confirmedAt).toBeNull();
      expect(u.where.variantId).toEqual({ not: u.data.variantId }); // 型が変わる宛先のみ
    }
  });

  it("field_staff は担当外物件の宛先を割当対象にしない(本文を勝手にクリア/再割当しない)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { id: "r1", property: { createdBy: "u1", assignedTo: "x" } }, // 担当内
      { id: "r2", property: { createdBy: "x", assignedTo: "x" } },  // 担当外→除外
    ]);
    const res = await assign(post({ mode: "auto", order: "sequential" }) as never, ctxC);
    expect(res.status).toBe(200);
    const allIds = pm.dmRecipientDraft.updateMany.mock.calls.flatMap((c) => c[0].where.id.in as string[]);
    expect(allIds).toContain("r1");
    expect(allIds).not.toContain("r2");
  });

  it("権限不足で 403・更新しない", async () => {
    grant("property");
    const res = await assign(post({ mode: "auto" }) as never, ctxC);
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("型が0件なら 409・更新しない", async () => {
    pm.dmVariant.findMany.mockResolvedValue([]);
    const res = await assign(post({ mode: "auto" }) as never, ctxC);
    expect(res.status).toBe(409);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST assign (manual)", () => {
  it("手動指定した宛先のみ更新し、未指定の宛先の型は書き換えない(A/Bバケット保全)", async () => {
    const res = await assign(post({ mode: "manual", assignments: [{ recipientId: "r1", variantId: "vB" }] }) as never, ctxC);
    expect(res.status).toBe(200);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    // 指定した r1 のみ vB へ割り当てる。
    const vBcall = calls.find((c) => c.data.variantId === "vB");
    expect(vBcall.where.id.in).toEqual(["r1"]);
    // 未指定の r2/r3/r4 はどの updateMany にも含まれない(既存の型を維持＝再割当しない)。
    const allIds = calls.flatMap((c) => c.where.id.in);
    expect(allIds).toEqual(["r1"]);
  });

  it("不正な variant/recipient の手動指定は無視し、何も更新しない(未指定も書き換えない)", async () => {
    const res = await assign(post({ mode: "manual", assignments: [{ recipientId: "r1", variantId: "ZZZ" }] }) as never, ctxC);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});
