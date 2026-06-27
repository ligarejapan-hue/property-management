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

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

// requireSaleDmAccess は Plan 1 の route-guard。ここではゲートを mock し、許可/403 を切り替える。
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
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/print/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
};

const variant = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  extraInstruction: null,
};
const draft = {
  id: "r1",
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区",
  body: "本文です",
  status: "confirmed",
  trackingToken: "tok1",
  variant,
};

const ctx = { params: Promise.resolve({ id: "c1" }) };
const req = () => new Request("http://x/api/properties/sale-dm/campaigns/c1/print");

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  // 郵送QRには絶対URLが必須。通常系は追跡baseを設定して通す。
  process.env = { ...ENV, SALE_DM_TRACKING_BASE_URL: "https://dm.example.com", SALE_DM_LP_URL: "https://lp.example.com" };
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト", createdBy: "u1" });
  pm.dmRecipientDraft.findMany.mockResolvedValue([draft]);
});

describe("GET .../campaigns/[id]/print", () => {
  it("確定分を text/html + no-store で返す", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("田中 一郎");
    expect(html).toContain("本文です");
    // 追跡QR/短縮URL が印刷HTMLへ配線されている(P5 slot 連携・宛先固有 /t/<token>)
    expect(html).toContain("sale-dm-tracking");
    expect(html).toContain("https://dm.example.com/t/tok1");
    // confirmed のみを問い合わせていること(status フィルタ)
    const arg = pm.dmRecipientDraft.findMany.mock.calls[0][0];
    expect(arg.where.campaignId).toBe("c1");
    expect(arg.where.status).toBe("confirmed");
  });

  it("追跡baseURL(SALE_DM_TRACKING_BASE_URL)未設定なら 503(郵送QRが相対パスで機能しないため fail-closed)", async () => {
    delete process.env.SALE_DM_TRACKING_BASE_URL;
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("LP URL(SALE_DM_LP_URL)未設定なら 503(郵送QRの遷移先が無く dead-link になるため)", async () => {
    delete process.env.SALE_DM_LP_URL;
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("非絶対の LP URL(lp.example.com)も 503(未設定扱い)", async () => {
    process.env.SALE_DM_LP_URL = "lp.example.com";
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(503);
  });

  it("印刷出力を非PIIメタで監査する(本文・宛名を含まない・直GETも追跡可能に)", async () => {
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalled();
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail.campaignId).toBe("c1");
    expect(detail.count).toBe(1);
    expect(JSON.stringify(detail)).not.toContain("田中");
    expect(JSON.stringify(detail)).not.toContain("本文");
  });

  it("複数共有者(coOwnerCount>1)は宛名に『他共有者様』が付く", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ ...draft, coOwnerCount: 2 }]);
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    expect(html).toContain("他共有者様");
  });

  it("単独所有者(coOwnerCount=1)は『他共有者様』が付かない", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ ...draft, coOwnerCount: 1 }]);
    const res = await GET(req() as never, ctx);
    const html = await res.text();
    expect(html).not.toContain("他共有者様");
  });

  it("確定 0 件でも 200(空ドキュメント)", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("letter-page ");
  });

  it("campaign 不在は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(404);
  });

  it("権限不足(ゲートが 403 throw)で 403・DB を読まない", async () => {
    requireSaleDmAccess.mockRejectedValue(new ApiError(403, "x", "FORBIDDEN"));
    const res = await GET(req() as never, ctx);
    expect(res.status).toBe(403);
    expect(pm.dmCampaign.findUnique).not.toHaveBeenCalled();
  });
});
