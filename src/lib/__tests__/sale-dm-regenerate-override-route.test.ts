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
    parseJsonBody: vi.fn(async () => ({})),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn() } },
}));
// generateLetters を spy して、resolveDraftOptions の結果(override 反映済み options)が渡ることを検証する。
const generateSpy = vi.fn(async (..._args: unknown[]) => ({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false }));
vi.mock("@/lib/sale-dm-letter", () => ({
  generateLetters: (...args: unknown[]) => generateSpy(...args),
  isSaleDmConfigured: () => true,
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST as regenerate } from "../../app/api/properties/sale-dm/drafts/[id]/regenerate/route";

const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(keys.map((k) => ({ resource: k, action: "read", granted: true })));
const ctx = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1", body: "再生成本文" });
});

describe("POST regenerate (override 反映)", () => {
  it("variant 設定に overrideJson を merge した options で生成する", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", recipientName: "田中 一郎", honorific: "様", coOwnerCount: 1,
      overrideJson: { tone: "soft" },
      variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
      property: { address: "東京都〇〇区", propertyType: "land", roomNo: null },
    });
    const res = await regenerate(new Request("http://x", { method: "POST" }) as never, ctx);
    expect(res.status).toBe(200);
    const passed = generateSpy.mock.calls[0][0] as { recipient: unknown; options: { tone: string; appeal: string } }[];
    // override の tone=soft が反映され、未指定 appeal は variant の price のまま
    expect(passed[0].options.tone).toBe("soft");
    expect(passed[0].options.appeal).toBe("price");
  });

  it("overrideJson が null なら variant 設定そのままで生成する", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", recipientName: "田中 一郎", honorific: "様", coOwnerCount: 1,
      overrideJson: null,
      variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
      property: { address: "東京都〇〇区", propertyType: "land", roomNo: null },
    });
    const res = await regenerate(new Request("http://x", { method: "POST" }) as never, ctx);
    expect(res.status).toBe(200);
    const passed = generateSpy.mock.calls[0][0] as { options: { tone: string; senderName: string } }[];
    expect(passed[0].options.tone).toBe("formal");
  });
});
