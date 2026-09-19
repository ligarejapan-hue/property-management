import { vi, describe, it, expect, beforeEach } from "vitest";

// Ruling P1(sale-dm-inquiry-api-route.test.ts と同じ作法): 実 route-guard(→ api-helpers →
// next-auth)を importOriginal すると vitest env=node で読み込めないため、next/server・
// api-helpers・route-guard・inquiry-notify を丸ごとモックする。
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

const { requireSaleDmAccess } = vi.hoisted(() => {
  const session = { id: "u1", role: "admin" };
  return {
    requireSaleDmAccess: vi.fn(async () => ({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } })),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess,
  // 実 filterDraftsByFieldStaffScope と同じ挙動(field_staff は作成/担当物件のみ・他は全件)。
  filterDraftsByFieldStaffScope: (
    drafts: Array<{ property?: { createdBy?: string | null; assignedTo?: string | null } }>,
    s: { id: string; role?: string },
  ) =>
    s?.role === "field_staff"
      ? drafts.filter((d) => d.property?.createdBy === s.id || d.property?.assignedTo === s.id)
      : drafts,
}));
// NOTIFY_STALE_CLAIM_MS は本物と同じ値(15分)をここでも export する(route.ts はこのモック
// 経由で import するため、値を揃えないと stale/fresh の境界がテストとずれる)。
vi.mock("@/lib/sale-dm-letter/inquiry-notify", () => ({
  startInquiryNotify: vi.fn(),
  NOTIFY_STALE_CLAIM_MS: 15 * 60_000,
}));

const db = vi.hoisted(() => ({
  dmInquiry: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ default: db }));

import { POST } from "@/app/api/properties/sale-dm/inquiries/[inquiryId]/notify/route";
import { startInquiryNotify, NOTIFY_STALE_CLAIM_MS } from "@/lib/sale-dm-letter/inquiry-notify";

const notify = startInquiryNotify as unknown as ReturnType<typeof vi.fn>;

const FOUND = {
  id: "inq1",
  notifyStatus: "failed",
  notifyClaimedAt: null as Date | null,
  draft: { property: { createdBy: "u1", assignedTo: null } },
};

const post = (inquiryId = "inq1") =>
  POST(new Request(`http://x/api/properties/sale-dm/inquiries/${inquiryId}/notify`, { method: "POST" }) as never, {
    params: Promise.resolve({ inquiryId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1", role: "admin" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
});

describe("POST /api/properties/sale-dm/inquiries/[inquiryId]/notify(再送)", () => {
  it("門(requireSaleDmAccess)の 403 はそのまま返し、DB を見ない", async () => {
    requireSaleDmAccess.mockRejectedValueOnce(
      Object.assign(new Error("閲覧権限がありません"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await post();
    expect(res.status).toBe(403);
    expect(db.dmInquiry.findUnique).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("申込が存在しなければ 404", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce(null);
    const res = await post();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(notify).not.toHaveBeenCalled();
  });

  it("field_staff の担当範囲外なら 404", async () => {
    requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmInquiry.findUnique.mockResolvedValueOnce({
      ...FOUND,
      draft: { property: { createdBy: "other", assignedTo: "someone-else" } },
    });
    const res = await post();
    expect(res.status).toBe(404);
    expect(notify).not.toHaveBeenCalled();
  });

  it("field_staff でも自分が作成/担当の物件なら通る(キャンペーン作成者である必要はない)", async () => {
    requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmInquiry.findUnique.mockResolvedValueOnce({
      ...FOUND,
      draft: { property: { createdBy: "other", assignedTo: "u1" } },
    });
    const res = await post();
    expect(res.status).toBe(202);
    expect(notify).toHaveBeenCalledWith("inq1");
  });

  // whole-branch review Important #1: "sending" のまま固まった行(サーバー再起動などで
  // in-process リトライが打ち切られたもの)を、この route からも直せるようにする。
  it("pending なら再送できる(202)", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce({ ...FOUND, notifyStatus: "pending", notifyClaimedAt: null });
    const res = await post();
    expect(res.status).toBe(202);
    expect(notify).toHaveBeenCalledWith("inq1");
  });

  it("sending でも保有(notifyClaimedAt)が保有期限より古ければ再送できる(202)", async () => {
    const stale = new Date(Date.now() - NOTIFY_STALE_CLAIM_MS - 1_000);
    db.dmInquiry.findUnique.mockResolvedValueOnce({ ...FOUND, notifyStatus: "sending", notifyClaimedAt: stale });
    const res = await post();
    expect(res.status).toBe(202);
    expect(notify).toHaveBeenCalledWith("inq1");
  });

  it("sending で保有がまだ新しい(いま送信中)なら 409 NOT_FAILED", async () => {
    const fresh = new Date(Date.now() - 1_000);
    db.dmInquiry.findUnique.mockResolvedValueOnce({ ...FOUND, notifyStatus: "sending", notifyClaimedAt: fresh });
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FAILED");
    expect(notify).not.toHaveBeenCalled();
  });

  it("sent なら 409 NOT_FAILED", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce({ ...FOUND, notifyStatus: "sent", notifyClaimedAt: new Date() });
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FAILED");
    expect(notify).not.toHaveBeenCalled();
  });

  it("failed なら startInquiryNotify を呼び 202(no-store)。キャンペーン作成者でなくても通る", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce(FOUND);
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ data: { started: true } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("inq1");
    // findUnique がキャンペーンの createdBy を条件に含めていない(作成者の縛りを入れない)ことも確認する。
    const args = db.dmInquiry.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ id: "inq1" });
    expect(JSON.stringify(args.select)).not.toContain("campaign");
  });
});
