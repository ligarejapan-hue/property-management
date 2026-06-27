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
  it("権限不足で 403", async () => {
    grant("property");
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(403);
  });
});

describe("PATCH draft (本文編集)", () => {
  it("body を更新し 200", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", body: "既存", campaignId: "c1", status: "draft", campaign: { createdBy: "u1" } });
    pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1", body: "編集後" });
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
  });
  it("存在しない draft は 404", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "no-such" }) });
    expect(res.status).toBe(404);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });
});

describe("POST confirm (bulk)", () => {
  it("指定 id を confirmed にし 200", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 2 });
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids }) }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
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

  it("正常に再生成し 200・update が呼ばれる", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(mockDraft);
    (generateLetters as ReturnType<typeof vi.fn>).mockResolvedValue({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false });
    pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1", body: "再生成本文" });
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1" }, data: { body: "再生成本文" } }));
  });
});
