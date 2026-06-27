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
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); if (t.trim() === "") return {}; try { return JSON.parse(t); } catch { throw new MockApiError(400, "リクエストボディが不正な JSON です", "INVALID_JSON"); } }),
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
    dmCampaign: { findUnique: vi.fn() },
    dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dmVariant: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/sale-dm-letter", () => ({ isSaleDmConfigured: vi.fn(), generateLetters: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/sender", () => ({ resolveSender: vi.fn(() => ({ senderName: "△△不動産", senderContact: "000" })) }));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { isSaleDmConfigured, generateLetters } from "@/lib/sale-dm-letter";
import { GET as getCampaign } from "../../app/api/properties/sale-dm/campaigns/[id]/route";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";
import { POST as confirmDrafts } from "../../app/api/properties/sale-dm/drafts/confirm/route";
import { POST as regenerateDraft } from "../../app/api/properties/sale-dm/drafts/[id]/regenerate/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })));
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
});

describe("GET campaign", () => {
  it("権限ありで 200・no-store・campaign+drafts を返す", async () => {
    grant(...ALL);
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "x", createdBy: "u1", variants: [], recipients: [{ id: "r1", body: "本文" }] });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("field_staff は担当外物件の宛先PIIを返さない・scope判定用propertyは応答に載せない", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmCampaign.findUnique.mockResolvedValue({
      id: "c1", name: "x", createdBy: "u1", variants: [],
      recipients: [
        { id: "r1", body: "b1", property: { createdBy: "u1", assignedTo: "x" } }, // 作成者=自分
        { id: "r2", body: "b2", property: { createdBy: "x", assignedTo: "u1" } }, // 担当=自分
        { id: "r3", body: "b3", property: { createdBy: "x", assignedTo: "x" } },  // 担当外→除外
      ],
    });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaign.recipients.map((r: { id: string }) => r.id)).toEqual(["r1", "r2"]);
    expect(json.campaign.recipients[0].property).toBeUndefined();
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(403);
  });
});

describe("PATCH draft (本文編集)", () => {
  it("body を更新し 200(条件付き updateMany で status!=sent をアトミックに)", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", body: "既存", campaignId: "c1", status: "draft", campaign: { createdBy: "u1" } });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    const where = pm.dmRecipientDraft.updateMany.mock.calls[0][0].where;
    expect(where).toEqual({ id: "r1", status: { not: "sent" } });
  });
  it("並行で sent 確定(updateMany count=0)なら 409・上書きしない", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", body: "既存", campaignId: "c1", status: "draft", campaign: { createdBy: "u1" } });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(409);
  });
  it("存在しない draft は 404", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "no-such" }) });
    expect(res.status).toBe(404);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST confirm (bulk)", () => {
  it("指定 id を confirmed にし 200(生成失敗=空bodyは確定対象から除外)", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 2 });
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids }) }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
    // 生成失敗(body="")の下書きは確定しない(空letterの確定→印刷→送付を防ぐ)。
    const where = pm.dmRecipientDraft.updateMany.mock.calls[0][0].where;
    expect(where.status).toBe("draft");
    expect(where.body).toEqual({ not: "" });
  });

  it("不正な JSON ボディは 400(500 でなく)・更新しない", async () => {
    grant(...ALL);
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: "{ broken" }) as never);
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("UUID でない id は 422(更新しない)", async () => {
    grant(...ALL);
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["not-a-uuid"] }) }) as never);
    expect(res.status).toBe(422);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("field_staff は作成/担当の物件の宛先のみ確定(where に property record scope を付与)", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(200);
    const where = pm.dmRecipientDraft.updateMany.mock.calls[0][0].where;
    // 担当外(再割当で隠れた)宛先は DB 側で確定対象から除外される。
    expect(where.property).toEqual({ OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] });
  });

  it("非 field_staff(管理者等)は confirm に property scope を付与しない", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany.mock.calls[0][0].where.property).toBeUndefined();
  });
});

describe("POST regenerate draft (再生成)", () => {
  const mockDraft = {
    id: "r1",
    recipientName: "田中 一郎",
    honorific: "様",
    coOwnerCount: 1,
    status: "confirmed",
    campaign: { createdBy: "u1" },
    property: { address: "東京都〇〇区", propertyType: "land", roomNo: null },
    variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
  };

  it("未設定の場合 503", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(503);
  });

  it("draft が存在しない場合 404", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(404);
  });

  it("field_staff が作成/担当でない物件の再生成は 403(record scope)", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      ...mockDraft,
      property: { address: "東京都〇〇区", propertyType: "land", roomNo: null, createdBy: "other", assignedTo: "other" },
    });
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(403);
  });

  it("正常に再生成し 200・条件付き updateMany(status!=sent)で書き込む", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(mockDraft);
    (generateLetters as ReturnType<typeof vi.fn>).mockResolvedValue({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1", status: { not: "sent" } }, data: { body: "再生成本文" } }));
  });

  it("生成中に並行で sent 確定(updateMany count=0)なら 409・本文を上書きしない", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(mockDraft);
    (generateLetters as ReturnType<typeof vi.fn>).mockResolvedValue({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(409);
  });
});
