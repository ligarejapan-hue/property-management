import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// LP型ごと/組み合わせの可否は公開LPのロールアウトスイッチ(SALE_DM_LP_PUBLIC_ENABLED)と同じ env で
// 決まる(@codex R10 P1)。ここでは **env を入れた世界と入れない世界の両方** を見る。
// env は毎回退避→復元する(他のテストへ漏らさない)。

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

const ENV = process.env;
beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV };
  (requireSaleDmAccess as Fn).mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト", createdBy: "u1" });
  pm.dmVariant.findMany.mockResolvedValue([{ id: "v1", label: "A" }]);
  pm.dmLpVariant.findMany.mockResolvedValue([{ id: "l1", label: "X" }]);
  pm.dmRecipientDraft.findMany.mockResolvedValue([
    { variantId: "v1", lpVariantId: "l1", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), lpPageFirstAt: new Date(), phoneInquiryAt: null, phoneTapFirstAt: new Date(), property: { createdBy: "u1", assignedTo: null } },
    { variantId: "v1", lpVariantId: null, deliveryStatus: "delivered", lpFirstAccessAt: null, lpPageFirstAt: null, phoneInquiryAt: null, phoneTapFirstAt: null, property: { createdBy: "u1", assignedTo: null } },
  ]);
});
afterEach(() => {
  process.env = ENV;
});

describe("GET aggregate(公開LPのスイッチが入っている)", () => {
  beforeEach(() => {
    process.env.SALE_DM_LP_PUBLIC_ENABLED = "1";
  });

  it("lpMetricsEnabled=true と二軸集計(byLpVariant / byPair)を返し、LP型なしは「LP型なし(外部LP)」のラベル", async () => {
    const json = await (await GET(new Request("http://x") as never, ctx())).json();
    expect(json.lpMetricsEnabled).toBe(true);
    expect(json.byLpVariant.map((x: { label: string }) => x.label)).toEqual(["LP型なし(外部LP)", "X"]);
    expect(json.byPair.length).toBe(2);
    expect(json.byPair[0].label).toContain("×");
    // DM型ごとの閲覧率はスイッチに関係なく同じ(文面の成績=QRの読み取り)。
    expect(json.byDmVariantView[0]).toMatchObject({ label: "A", viewed: 1, delivered: 2, viewRate: 0.5 });
    // LP型ごとに電話タップの件数/率も返す(分母=アプリ内ページの閲覧)。
    const lpX = json.byLpVariant.find((x: { lpVariantId: string }) => x.lpVariantId === "l1");
    expect(lpX).toMatchObject({ viewed: 1, phoneTapped: 1, phoneTapRate: 1 });
  });

  it('"true"(大小無視)でも有効・"yes" や "0" は無効(公開ページの判定と同じ読み方)', async () => {
    process.env.SALE_DM_LP_PUBLIC_ENABLED = "TRUE";
    expect((await (await GET(new Request("http://x") as never, ctx())).json()).lpMetricsEnabled).toBe(true);
    process.env.SALE_DM_LP_PUBLIC_ENABLED = "yes";
    expect((await (await GET(new Request("http://x") as never, ctx())).json()).lpMetricsEnabled).toBe(false);
    process.env.SALE_DM_LP_PUBLIC_ENABLED = "0";
    expect((await (await GET(new Request("http://x") as never, ctx())).json()).lpMetricsEnabled).toBe(false);
  });
});

describe("GET aggregate(公開LPのスイッチが未投入=段階反映中の既定)", () => {
  beforeEach(() => {
    delete process.env.SALE_DM_LP_PUBLIC_ENABLED;
  });

  it("lpMetricsEnabled=false で byLpVariant / byPair を**返さない**(外部LPへの訪問をページの成績として配らない)", async () => {
    const json = await (await GET(new Request("http://x") as never, ctx())).json();
    expect(json.lpMetricsEnabled).toBe(false);
    expect(Object.keys(json)).not.toContain("byLpVariant");
    expect(Object.keys(json)).not.toContain("byPair");
  });

  it("DM型ごとの閲覧率(文面の成績)と反響の表はスイッチに関係なく返す", async () => {
    const json = await (await GET(new Request("http://x") as never, ctx())).json();
    expect(json.byDmVariantView[0]).toMatchObject({ label: "A", viewed: 1, delivered: 2, viewRate: 0.5 });
    expect(json.total.sent).toBe(2);
  });
});
