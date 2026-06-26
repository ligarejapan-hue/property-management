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
    // Resolution A: mirror real handleApiError — ZodError (has issues array) → 422, MockApiError → status, else 500
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e && Array.isArray((e as Record<string, unknown>).issues)) {
        return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn(), findFirst: vi.fn() },
    dmVariant: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findFirst: vi.fn() },
    dmRecipientDraft: { count: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET as listVariants, POST as createVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/route";
import { PATCH as updateVariant, DELETE as deleteVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  dmVariant: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { count: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
    keys.map((k) => ({ resource: k, action: "read", granted: true })),
  );
const optionFields = { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" };
const ctxC = { params: Promise.resolve({ id: "c1" }) };
const ctxV = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  // assertSaleDmCampaignOwned 用: 既定で作成者本人のキャンペーン(owned)。
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
});

describe("GET variants", () => {
  it("権限ありで 200・no-store・型一覧を返す", async () => {
    pm.dmVariant.findMany.mockResolvedValue([{ id: "v1", label: "A", ...optionFields }]);
    const res = await listVariants(new Request("http://x") as never, ctxC);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.variants).toHaveLength(1);
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await listVariants(new Request("http://x") as never, ctxC);
    expect(res.status).toBe(403);
  });
});

describe("POST variant (作成)", () => {
  it("label + options 一式で作成し 200", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    pm.dmVariant.create.mockResolvedValue({ id: "v2", label: "B", ...optionFields });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.create).toHaveBeenCalled();
    const arg = pm.dmVariant.create.mock.calls[0][0];
    expect(arg.data.campaignId).toBe("c1");
    expect(arg.data.label).toBe("B");
    expect(arg.data.tone).toBe("formal");
  });
  it("存在しない campaign で 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(res.status).toBe(404);
  });
  it("不正な options で 422(zod)", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: { ...optionFields, tone: "loud" } }) }) as never, ctxC);
    expect(res.status).toBe(422);
  });
});

describe("PATCH variant (更新)", () => {
  it("設定一式の部分更新で 200・campaignId で縛る", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0); // 送付済みの宛先なし
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2", options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(200);
    const arg = pm.dmVariant.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "v1", campaignId: "c1" });
    expect(arg.data.tone).toBe("soft");
    expect(arg.data.label).toBe("A2");
  });

  it("送付済みの宛先がある型は設定変更を拒否(409 VARIANT_LOCKED)・更新しない", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(2); // この型を使った送付済みドラフトが存在
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(409);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
    const countArg = pm.dmRecipientDraft.count.mock.calls[0][0];
    expect(countArg.where).toMatchObject({ campaignId: "c1", variantId: "v1", status: "sent" });
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "x" }) }) as never, ctxV);
    expect(res.status).toBe(403);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
  });
});

describe("DELETE variant (削除ガード)", () => {
  it("割当済みドラフトが無ければ削除し 200", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.delete.mockResolvedValue({ id: "v1" });
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.delete).toHaveBeenCalledWith({ where: { id: "v1", campaignId: "c1" } });
  });
  it("割当済みドラフトがあれば 409・削除しない", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(3);
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(409);
    expect(pm.dmVariant.delete).not.toHaveBeenCalled();
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(403);
    expect(pm.dmVariant.delete).not.toHaveBeenCalled();
  });
});
