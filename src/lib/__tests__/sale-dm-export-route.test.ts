import { vi } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const { requireSaleDmAccess } = vi.hoisted(() => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess }));

vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/export/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
};

const variant = {
  label: "A",
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
};
const draft = {
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区",
  status: "confirmed",
  body: "本文",
  variant,
};

const ctx = { params: Promise.resolve({ id: "c1" }) };
const req = () => new Request("http://x/api/properties/sale-dm/campaigns/c1/export");

beforeEach(() => {
  vi.clearAllMocks();
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト", createdBy: "u1" });
  pm.dmRecipientDraft.findMany.mockResolvedValue([draft]);
});

describe("GET .../campaigns/[id]/export", () => {
  it("text/csv + BOM + no-store + attachment で返す", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    // BOM はバイト列で確認する（Response.text() は先頭 BOM を decode 時に剥がすため）。
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const csv = await res.text();
    expect(csv).toContain("型,デザイン"); // ヘッダ
    expect(csv).toContain("田中 一郎");
    expect(csv).toContain("\r\n"); // CRLF
  });

  it("複数共有者(coOwnerCount>1)は敬称が『様 他共有者様』になる", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ ...draft, coOwnerCount: 2 }]);
    const res = await GET(req() as never, ctx);
    const csv = await res.text();
    expect(csv).toContain("様 他共有者様");
  });

  it("formula injection: 先頭 = で始まる値は ' でエスケープされる", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { ...draft, recipientName: "=HYPERLINK(1)" },
    ]);
    const res = await GET(req() as never, ctx);
    const csv = await res.text();
    expect(csv).toContain("'=HYPERLINK(1)");
  });

  it("カンマ/改行/クオートを含む本文は RFC quoting される", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { ...draft, body: 'a,b\n"c"' },
    ]);
    const res = await GET(req() as never, ctx);
    const csv = await res.text();
    expect(csv).toContain('"a,b\n""c"""');
  });

  it("AuditLog は非PIIメタのみ(本文を含まない)", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledOnce();
    const detail = writeAuditLog.mock.calls[0][0].detail;
    expect(detail.campaignId).toBe("c1");
    expect(JSON.stringify(detail)).not.toContain("本文");
    expect(JSON.stringify(detail)).not.toContain("田中");
  });

  it("campaign 不在は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(404);
  });

  it("権限不足で 403・DB を読まない", async () => {
    requireSaleDmAccess.mockRejectedValue(new ApiError(403, "x", "FORBIDDEN"));
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(403);
    expect(pm.dmCampaign.findUnique).not.toHaveBeenCalled();
  });
});
