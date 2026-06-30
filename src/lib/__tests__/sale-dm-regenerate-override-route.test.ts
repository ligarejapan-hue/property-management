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
    parseJsonBody: vi.fn(async () => ({ confirmed: true })), // 再生成は confirmed:true 必須(課金確認)
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() } },
}));
// generateLetters を spy して、resolveDraftOptions の結果(override 反映済み options)が渡ることを検証する。
const generateSpy = vi.fn(async (...args: unknown[]) => {
  void args; // 呼び出し引数は mock.calls で検証する(本体では未使用)。
  return { drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false };
});
vi.mock("@/lib/sale-dm-letter", () => ({
  generateLetters: (...args: unknown[]) => generateSpy(...args),
  isSaleDmConfigured: () => true,
  resolveProvider: () => ({ name: "mock", generate: async () => ({ body: "x" }) }),
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST as regenerate } from "../../app/api/properties/sale-dm/drafts/[id]/regenerate/route";

const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> } };
const ALL = ["property", "csv_export", "csv_export_personal", "owner", "sale_dm"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
    keys.map((k) => ({ resource: k, action: k === "sale_dm" ? "generate" : "read", granted: true })),
  );
const ctx = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  // 差出人ゲート(R32): 再生成も差出人未設定なら生成前に 503。実 isSenderConfigured(env 判定)が
  // true を返すよう差出人 env を設定する(この test は sender を mock せず実体を使う)。
  process.env.SALE_DM_SENDER_NAME = "△△不動産";
  process.env.SALE_DM_SENDER_CONTACT = "03-0000-0000";
  // 印刷URLゲート(R34): 実 resolveTrackingBaseUrl/resolveLpUrl(env 判定)が値を返すよう設定。
  process.env.SALE_DM_TRACKING_BASE_URL = "https://app.example.com";
  process.env.SALE_DM_LP_URL = "https://lp.example.com";
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1", body: "再生成本文" });
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST regenerate (override 反映)", () => {
  it("variant 設定に overrideJson を merge した options で生成する", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", recipientName: "田中 一郎", honorific: "様", coOwnerCount: 1,
      status: "confirmed", campaign: { createdBy: "u1" },
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
    // 有料AI+PII外部送信のため非PII監査を残す(初回作成以降の課金/送信も追跡可能に)。
    expect(writeAuditLog).toHaveBeenCalled();
    expect((writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].action).toBe("sale_dm_draft_regenerate");
  });

  it("overrideJson が null なら variant 設定そのままで生成する", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", recipientName: "田中 一郎", honorific: "様", coOwnerCount: 1,
      status: "confirmed", campaign: { createdBy: "u1" },
      overrideJson: null,
      variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
      property: { address: "東京都〇〇区", propertyType: "land", roomNo: null },
    });
    const res = await regenerate(new Request("http://x", { method: "POST" }) as never, ctx);
    expect(res.status).toBe(200);
    const passed = generateSpy.mock.calls[0][0] as { options: { tone: string; senderName: string } }[];
    expect(passed[0].options.tone).toBe("formal");
  });

  it("sale_dm:generate なしでは 403・生成しない(有料AIの専用権限を必須化)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner"); // sale_dm を渡さない
    const res = await regenerate(new Request("http://x", { method: "POST" }) as never, ctx);
    expect(res.status).toBe(403);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});
