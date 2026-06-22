import { describe, it, expect, vi, beforeEach } from "vitest";

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
  // 実 handleApiError を模倣: status を持つ error はその status、zod(issues)は 422、他は 500。
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) => {
      if (e && typeof e === "object") {
        const x = e as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
        if (typeof x.status === "number") {
          return Response.json({ error: { message: x.message, code: x.code } }, { status: x.status });
        }
        if (Array.isArray(x.issues)) {
          return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
        }
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmVariant: { findMany: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn() },
  },
}));

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/aggregate/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmVariant: { findMany: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
};
const ctx = (id = "c1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト" });
  pm.dmVariant.findMany.mockResolvedValue([
    { id: "vA", label: "A" },
    { id: "vB", label: "B" },
  ]);
});

describe("GET aggregate", () => {
  it("型別集計+型ラベルを返す・no-store", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { variantId: "vA", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), phoneInquiryAt: null },
      { variantId: "vA", deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null },
      { variantId: "vB", deliveryStatus: "returned_undeliverable", lpFirstAccessAt: null, phoneInquiryAt: null },
    ]);
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.total.sent).toBe(3);
    expect(json.total.delivered).toBe(2);
    expect(json.total.undeliverable).toBe(1);
    const vA = json.byVariant.find((v: { variantId: string }) => v.variantId === "vA");
    expect(vA.label).toBe("A");
    expect(vA.delivered).toBe(2);
    expect(vA.responseRate).toBeCloseTo(1 / 2, 5);
  });

  it("0件は total 全ゼロ・byVariant=[]", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.byVariant).toEqual([]);
    expect(json.total.sent).toBe(0);
    expect(json.total.responseRate).toBeNull();
  });

  it("存在しない campaign は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(404);
  });

  it("権限不足で 403", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(403);
  });
});
