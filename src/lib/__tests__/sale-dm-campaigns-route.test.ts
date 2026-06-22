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
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    dmCampaign: { create: vi.fn() }, dmVariant: { create: vi.fn() }, dmRecipientDraft: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      dmCampaign: { create: vi.fn(async () => ({ id: "c1" })) },
      dmVariant: { create: vi.fn(async () => ({ id: "v1" })) },
      dmRecipientDraft: { create: vi.fn() },
    })),
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import { writeAuditLog } from "@/lib/audit";
import { buildRecipientsFromProperties } from "../sale-dm-letter/recipients";

// dm-export と同じ select 形状の最小 fixture
const ownerDisplayConfig = { name: "full", zip: "full", address: "full", nameKana: "full" } as never;

const property = {
  id: "p1",
  address: "東京都〇〇区△△1-2-3",
  propertyType: "land",
  roomNo: null,
  propertyOwners: [
    { isPrimary: true, relationship: null, owner: { name: "田中 一郎", nameKana: null, zip: "1000001", address: "東京都〇〇区△△1-2-3", corporateNumber: null } },
  ],
};

describe("buildRecipientsFromProperties", () => {
  it("代表者・敬称・物件種別ラベルを持つ recipient を作る", () => {
    const { recipients, meta } = buildRecipientsFromProperties([property as never], ownerDisplayConfig);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].representativeName).toBe("田中 一郎");
    expect(recipients[0].honorific).toBe("様");
    expect(recipients[0].propertyTypeLabel).toBeTruthy();
    expect(meta[0].propertyId).toBe("p1");
    expect(meta[0].recipientAddress).toBe("東京都〇〇区△△1-2-3");
    expect(meta[0].coOwnerCount).toBe(1);
  });
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST } from "../../app/api/properties/sale-dm/campaigns/route";

// getUserPermissions は { resource, action, granted } の配列を返す(dm-export route test と同形)。
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
  ["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })),
);
const plain = { name: "full", zip: "full", address: "full", nameKana: "full" };
const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const validBody = { name: "テスト", options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", senderName: "△△", senderContact: "000" } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_USE_MOCK = "true"; // generation を mock provider + 設定済みに
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue(plain);
  (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([]);
});

describe("POST /api/properties/sale-dm/campaigns", () => {
  it("権限不足(property:read なし)で 403・生成も保存もしない", async () => {
    grant("csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("0件対象でも 200・campaignId を返す", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("env 未設定(mock off + provider 未設定)で 503", async () => {
    delete process.env.NEXT_PUBLIC_USE_MOCK;
    grant("property", "csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(503);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });
});
