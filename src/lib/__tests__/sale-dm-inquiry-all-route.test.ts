import { vi, describe, it, expect, beforeEach } from "vitest";

// Ruling P1(sale-dm-inquiry-api-route.test.ts と同じ作法): 実 route-guard(→ api-helpers →
// next-auth)を importOriginal すると vitest env=node で読み込めないため、next/server・
// api-helpers・route-guard・dm-export・inquiry-notify を丸ごとモックする。tags(coarsePropertyLocation/
// propertyTypeLabel)は純関数なので実物を使う。
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
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

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
vi.mock("@/lib/dm-export", () => ({ isPlainOwnerLevel: (l: string) => l === "full" }));

const { countInquiryNotifyRecipients } = vi.hoisted(() => ({
  countInquiryNotifyRecipients: vi.fn(async () => 3),
}));
vi.mock("@/lib/sale-dm-letter/inquiry-notify", () => ({ countInquiryNotifyRecipients }));

const db = vi.hoisted(() => ({
  dmInquiry: { findMany: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ default: db }));

import { GET } from "@/app/api/properties/sale-dm/inquiries/route";
import { writeAuditLog } from "@/lib/audit";

const session = { id: "u1", role: "admin" };

const INQ = {
  id: "i1", draftId: "d1", submittedAt: new Date("2026-09-20T00:00:00Z"), name: "山田", phone: "090", email: null,
  contactPref: null, contactTime: null, message: null, handleStatus: "open", handledAt: null, handleNote: null,
  notifyStatus: "pending",
  draft: {
    campaign: { id: "c1", name: "秋の売却促進" },
    property: { address: "東京都新宿区西新宿2丁目8番1号 新宿ビル101", propertyType: "land", createdBy: "u1", assignedTo: null },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireSaleDmAccess.mockResolvedValue({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
  countInquiryNotifyRecipients.mockResolvedValue(3);
  db.dmInquiry.groupBy.mockResolvedValue([]);
});

const get = (qs = "") => GET(new Request(`http://x/api${qs}`) as never);
const cursorOf = (t: string, i: string) => Buffer.from(JSON.stringify({ t, i })).toString("base64url");
const UUID = "0b9c7f1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b";

describe("GET /api/properties/sale-dm/inquiries(横断)", () => {
  it("requireSaleDmAccess を通れば作成者でなくても全キャンペーンの申込が返る(where に campaign を含まない)", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    const res = await get();
    expect(res.status).toBe(200);
    const args = db.dmInquiry.findMany.mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(JSON.stringify(args.where)).not.toContain("campaign");
    const body = await res.json();
    expect(body.inquiries[0]).toMatchObject({ id: "i1", campaignId: "c1", campaignName: "秋の売却促進" });
  });

  it("field_staff は where.draft.property.OR に本人条件を積む(SQL側の絞り込み)", async () => {
    requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    await get();
    const args = db.dmInquiry.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ draft: { property: { OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] } } });
    const groupByWhere = db.dmInquiry.groupBy.mock.calls[0][0].where;
    expect(groupByWhere).toEqual({ draft: { property: { OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] } } });
  });

  it("field_staff は担当外の物件の申込を返さない(多層防御)", async () => {
    requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmInquiry.findMany.mockResolvedValueOnce([
      { ...INQ, draft: { ...INQ.draft, property: { ...INQ.draft.property, createdBy: "other", assignedTo: "someone-else" } } },
    ]);
    const body = await (await get()).json();
    expect(body.inquiries).toEqual([]);
  });

  it("並びは submittedAt desc, id desc・skip なし・take 101(PR4 と同じ不変ストリーム)", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    await get();
    const args = db.dmInquiry.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ submittedAt: "desc" }, { id: "desc" }]);
    expect(args).not.toHaveProperty("skip");
    expect(args.take).toBe(101);
    expect(args.where).not.toHaveProperty("handleStatus");
  });

  it("正しい cursor はキーセット条件を積む(submittedAt < t または同時刻で id < i)", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    const t = "2026-09-20T01:02:03.456Z";
    await get(`?cursor=${cursorOf(t, UUID)}`);
    const where = db.dmInquiry.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { submittedAt: { lt: new Date(t) } },
      { submittedAt: new Date(t), id: { lt: UUID } },
    ]);
  });

  it("不正な cursor は先頭ページ扱い(キーセット条件なし)", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    const res = await get("?cursor=!!!");
    expect(res.status).toBe(200);
    expect(db.dmInquiry.findMany.mock.calls[0][0].where).not.toHaveProperty("OR");
  });

  it("101件返ると hasMore=true・100件だけ返し、nextCursor は100件目の submittedAt/id", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      ...INQ, id: `i${i}`, submittedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - i * 1000),
    }));
    db.dmInquiry.findMany.mockResolvedValueOnce(rows);
    const body = await (await get()).json();
    expect(body.hasMore).toBe(true);
    expect(body.inquiries).toHaveLength(100);
    expect(JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8"))).toEqual({ t: rows[99].submittedAt.toISOString(), i: "i99" });
  });

  it("最後のページは hasMore=false・nextCursor=null", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    const body = await (await get()).json();
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("counts は groupBy 1回で集計する(範囲全体・カーソル条件を含まない)", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    db.dmInquiry.groupBy.mockResolvedValueOnce([
      { handleStatus: "open", _count: { _all: 3 } },
      { handleStatus: "done", _count: { _all: 4 } },
    ]);
    const body = await (await get(`?cursor=${cursorOf("2026-09-20T01:02:03.456Z", UUID)}`)).json();
    expect(body.counts).toEqual({ active: 3, done: 4 });
    expect(db.dmInquiry.groupBy).toHaveBeenCalledTimes(1);
    const where = db.dmInquiry.groupBy.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("OR");
  });

  it("電話は見えるがメール(owner_email)の表示権限が無ければメールと自由記述だけ伏せる(2x2 のうち (true,false)を1本・@codex P1)", async () => {
    requireSaleDmAccess.mockResolvedValueOnce({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "masked" } });
    db.dmInquiry.findMany.mockResolvedValueOnce([
      { ...INQ, email: "a@b.jp", contactTime: "夜", message: "要望です", handleNote: "折り返し済み" },
    ]);
    const body = await (await get()).json();
    expect(body.inquiries[0]).toMatchObject({
      phone: "090", contactHidden: false, email: null, emailHidden: true,
      contactTime: null, message: null, handleNote: null, freeTextHidden: true,
      notifyStatus: "pending", // notifyStatus は個人情報ではないので伏せ対象にならない
    });
  });

  it("notifyRecipientCount を返す", async () => {
    countInquiryNotifyRecipients.mockResolvedValueOnce(0);
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    const body = await (await get()).json();
    expect(body.notifyRecipientCount).toBe(0);
  });

  // whole-branch review Minor #5: notifyRecipientCount>0 でも「その全員が売却DMの閲覧権限を
  // 持たない」場合は毎回 no_recipients で失敗する。N+1 の権限チェックを足さず、行の
  // notifyLastError をそのまま返して画面側で案内する(個人情報ではないので伏せない)。
  it("notifyLastError を行に含めて返す(個人情報ではないので表示権限に関わらず返す)", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([
      { ...INQ, notifyStatus: "failed", notifyLastError: "no_recipients" },
    ]);
    const body = await (await get()).json();
    expect(body.inquiries[0].notifyLastError).toBe("no_recipients");
  });

  it("notifyLastError=null(未失敗)はそのまま null で返る", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([{ ...INQ, notifyLastError: null }]);
    const body = await (await get()).json();
    expect(body.inquiries[0].notifyLastError).toBeNull();
  });

  it("行に campaignId/campaignName/location(物件所在の粗い表示)/propertyTypeLabel を付与する。住所そのものは含まない", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    const body = await (await get()).json();
    expect(body.inquiries[0]).toMatchObject({
      campaignId: "c1",
      campaignName: "秋の売却促進",
      location: "東京都新宿区西新宿2丁目",
      propertyTypeLabel: "土地",
    });
    expect(JSON.stringify(body.inquiries[0])).not.toContain("新宿ビル101");
    expect(body.inquiries[0]).not.toHaveProperty("draft");
    expect(body.inquiries[0]).not.toHaveProperty("property");
  });

  it("監査は sale_dm_inquiry_view・targetTable=dm_inquiries・targetId なし・detail は count と viewedAt のみ", async () => {
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    await get();
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit).toMatchObject({ userId: "u1", action: "sale_dm_inquiry_view", targetTable: "dm_inquiries" });
    expect(audit).not.toHaveProperty("targetId");
    expect(Object.keys(audit.detail).sort()).toEqual(["count", "viewedAt"]);
    expect(audit.detail.count).toBe(1);
  });
});
