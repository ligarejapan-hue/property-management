import { describe, it, expect, vi, beforeEach } from "vitest";

// 旗を **true にした世界**だけを見る別ファイル(@codex R4 P2)。同じファイル内で旗を差し替えると
// 他のテスト(旗 false のときは返さない)まで巻き添えになるため、モジュール単位で分ける。
vi.mock("@/lib/sale-dm-letter/lp-metrics-flag", () => ({ LP_METRICS_ENABLED: true }));

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
    handleApiError: vi.fn((e: unknown) => {
      if (e && typeof e === "object") {
        const x = e as { status?: unknown; code?: unknown; message?: unknown };
        if (typeof x.status === "number") {
          return Response.json({ error: { message: x.message, code: x.code } }, { status: x.status });
        }
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess: vi.fn(),
  filterDraftsByFieldStaffScope: (
    drafts: Array<{ property?: { createdBy?: string | null; assignedTo?: string | null } }>,
    session: { id: string; role?: string },
  ) =>
    session?.role === "field_staff"
      ? drafts.filter((d) => d.property?.createdBy === session.id || d.property?.assignedTo === session.id)
      : drafts,
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmVariant: { findMany: vi.fn() },
    dmLpVariant: { findMany: vi.fn(async () => []) },
    dmRecipientDraft: { findMany: vi.fn() },
  },
}));

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/aggregate/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findUnique: Fn };
  dmVariant: { findMany: Fn };
  dmLpVariant: { findMany: Fn };
  dmRecipientDraft: { findMany: Fn };
};
const ctx = (id = "c1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as Fn).mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト", createdBy: "u1" });
});

describe("GET aggregate(LP指標の旗が true)", () => {
  it("二軸集計(byLpVariant / byPair)を返し、LP型なしは「LP型なし(外部LP)」のラベル", async () => {
    pm.dmVariant.findMany.mockResolvedValue([{ id: "v1", label: "A" }]);
    pm.dmLpVariant.findMany.mockResolvedValue([{ id: "l1", label: "X" }]);
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { variantId: "v1", lpVariantId: "l1", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), phoneInquiryAt: null, property: { createdBy: "u1", assignedTo: null } },
      { variantId: "v1", lpVariantId: null, deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null, property: { createdBy: "u1", assignedTo: null } },
    ]);
    const json = await (await GET(new Request("http://x") as never, ctx())).json();
    expect(json.byLpVariant.map((x: { label: string }) => x.label)).toEqual(["LP型なし(外部LP)", "X"]);
    expect(json.byPair.length).toBe(2);
    expect(json.byPair[0].label).toContain("×");
    // DM型ごとの閲覧率は旗に関係なく同じ。
    expect(json.byDmVariantView[0]).toMatchObject({ label: "A", viewed: 1, delivered: 2, viewRate: 0.5 });
  });
});
