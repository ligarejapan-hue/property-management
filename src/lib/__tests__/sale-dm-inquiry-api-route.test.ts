import { vi, describe, it, expect, beforeEach } from "vitest";

// Ruling P1: 実 route-guard(→ api-helpers → next-auth)を importOriginal すると
// vitest env=node で読み込めない。sale-dm-aggregate-route.test.ts の作法(next/server・
// api-helpers・route-guard・dm-export を丸ごとモック)に合わせる。
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
    parseJsonBody: vi.fn(async (req: Request) => req.json()),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));

// ⚠vi.mock ファクトリは(vi.mock 呼び出し自体のホイストにより)ファイル内の他の
// top-level const より先に評価される。ファクトリの中から参照する可変値は
// vi.hoisted で作る(campaigns-route.test.ts と同じ作法)。db は $transaction が
// tx として自分自身を渡す必要があるため、hoisted のコールバック内で自己参照する。
const { requireSaleDmAccess, requireSaleDmWriteAccess } = vi.hoisted(() => {
  const session = { id: "u1", role: "admin" };
  return {
    requireSaleDmAccess: vi.fn(async () => ({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } })),
    requireSaleDmWriteAccess: vi.fn(async () => ({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } })),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess,
  requireSaleDmWriteAccess,
  // 実 filterDraftsByFieldStaffScope と同じ挙動を再現(field_staff は作成/担当物件のみ・他は全件)。
  filterDraftsByFieldStaffScope: (
    drafts: Array<{ property?: { createdBy?: string | null; assignedTo?: string | null } }>,
    s: { id: string; role?: string },
  ) =>
    s?.role === "field_staff"
      ? drafts.filter((d) => d.property?.createdBy === s.id || d.property?.assignedTo === s.id)
      : drafts,
}));
vi.mock("@/lib/dm-export", () => ({ isPlainOwnerLevel: (l: string) => l === "full" }));

const db = vi.hoisted(() => {
  const self = {
    dmCampaign: { findUnique: vi.fn() },
    dmInquiry: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(self)),
  };
  return self;
});
vi.mock("@/lib/prisma", () => ({ default: db }));

const guard = { requireSaleDmAccess, requireSaleDmWriteAccess };
const session = { id: "u1", role: "admin" };

import { GET } from "@/app/api/properties/sale-dm/campaigns/[id]/inquiries/route";
import { PATCH } from "@/app/api/properties/sale-dm/inquiries/[inquiryId]/route";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";

const INQ = {
  id: "i1", draftId: "d1", submittedAt: new Date("2026-09-20T00:00:00Z"), name: "山田", phone: "090", email: null,
  contactPref: null, contactTime: null, message: null, handleStatus: "open", handledAt: null, handleNote: null,
  draft: { property: { createdBy: "u1", assignedTo: null } },
};

beforeEach(() => { vi.clearAllMocks(); });

describe("GET 申込一覧", () => {
  it("作成者本人のキャンペーンのみ。他人は 404", async () => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "other" });
    const res = await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(404);
    expect(db.dmInquiry.findMany).not.toHaveBeenCalled();
  });
  it("返す・監査は件数と時刻のみ", async () => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([INQ]);
    const res = await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inquiries[0]).toMatchObject({ id: "i1", name: "山田", phone: "090", contactHidden: false });
    expect(body.inquiries[0]).not.toHaveProperty("draft");
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit).toMatchObject({ action: "sale_dm_inquiry_view", targetId: "c1" });
    expect(Object.keys(audit.detail).sort()).toEqual(["count", "viewedAt"]);
  });
  it("電話の表示権限が無ければ連絡先を伏せる", async () => {
    guard.requireSaleDmAccess.mockResolvedValueOnce({ session, permissions: [], ownerDisplayConfig: { phone: "masked", email: "masked" } });
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([{ ...INQ, handleNote: "折り返し 090-1111-2222" }]);
    const body = await (await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) })).json();
    expect(body.inquiries[0]).toMatchObject({ phone: null, handleNote: null, contactHidden: true, emailHidden: true });
  });
  it("電話は見えるがメール(owner_email)の表示権限が無ければメールだけ伏せる(@codex P1)", async () => {
    guard.requireSaleDmAccess.mockResolvedValueOnce({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "masked" } });
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([{ ...INQ, email: "a@b.jp" }]);
    const body = await (await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) })).json();
    expect(body.inquiries[0]).toMatchObject({ phone: "090", contactHidden: false, email: null, emailHidden: true });
  });
  it("field_staff は担当外の物件の申込を返さない", async () => {
    guard.requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([{ ...INQ, draft: { property: { createdBy: "x", assignedTo: "y" } } }]);
    const body = await (await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) })).json();
    expect(body.inquiries).toEqual([]);
  });
  it("skip/take/orderBy をオフセット方式で組み立てる", async () => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    await GET(new Request("http://x/api?offset=100") as never, { params: Promise.resolve({ id: "c1" }) });
    const args = db.dmInquiry.findMany.mock.calls[0][0];
    expect(args.skip).toBe(100);
    expect(args.take).toBe(101);
    expect(args.orderBy).toEqual([{ handleStatus: "desc" }, { submittedAt: "desc" }, { id: "desc" }]);
  });
  it("101件返ると hasMore=true・nextOffset=100・100件だけ返す", async () => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    const rows = Array.from({ length: 101 }, (_, i) => ({ ...INQ, id: `i${i}` }));
    db.dmInquiry.findMany.mockResolvedValueOnce(rows);
    const body = await (await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) })).json();
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(100);
    expect(body.inquiries).toHaveLength(100);
  });
  it("field_staff は where.draft.property.OR に本人条件を積む(SQL側の絞り込み)", async () => {
    guard.requireSaleDmAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    await GET(new Request("http://x/api") as never, { params: Promise.resolve({ id: "c1" }) });
    const args = db.dmInquiry.findMany.mock.calls[0][0];
    expect(args.where.draft.property.OR).toEqual([{ createdBy: "u1" }, { assignedTo: "u1" }]);
  });
  it.each(["-5", "abc"])("不正な offset=%s は 0 扱い", async (offset) => {
    db.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c1", createdBy: "u1" });
    db.dmInquiry.findMany.mockResolvedValueOnce([]);
    await GET(new Request(`http://x/api?offset=${offset}`) as never, { params: Promise.resolve({ id: "c1" }) });
    expect(db.dmInquiry.findMany.mock.calls[0][0].skip).toBe(0);
  });
});

describe("PATCH 対応状況", () => {
  const patch = (b: unknown) => PATCH(new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }) as never, { params: Promise.resolve({ inquiryId: "i1" }) });
  const FOUND = { id: "i1", draft: { propertyId: "p1", campaign: { createdBy: "u1" }, property: { createdBy: "u1", assignedTo: null } } };

  it("列挙外の状態は 422", async () => {
    expect((await patch({ handleStatus: "closed" })).status).toBe(422);
  });
  it("他人のキャンペーンの申込は 404", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce({ ...FOUND, draft: { ...FOUND.draft, campaign: { createdBy: "other" } } });
    expect((await patch({ handleStatus: "done" })).status).toBe(404);
  });
  it("親の物件行をロックしてから更新。done は処理者と時刻を入れ、open に戻すと時刻を消す。監査は状態と時刻のみ", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce(FOUND).mockResolvedValueOnce(FOUND);
    db.dmInquiry.update.mockResolvedValueOnce({ id: "i1", handleStatus: "done", handledAt: new Date(), handleNote: "折り返し済み" });
    const res = await patch({ handleStatus: "done", handleNote: "折り返し済み" });
    expect(res.status).toBe(200);
    expect(lockPropertyRow).toHaveBeenCalledWith(db, "p1");
    const data = db.dmInquiry.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ handleStatus: "done", handledById: "u1", handleNote: "折り返し済み" });
    expect(data.handledAt).toBeInstanceOf(Date);
    const audit = (writeAuditLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(audit.detail).sort()).toEqual(["handleStatus", "updatedAt"]);
    expect(JSON.stringify(audit)).not.toContain("折り返し済み");

    db.dmInquiry.findUnique.mockResolvedValueOnce(FOUND).mockResolvedValueOnce(FOUND);
    db.dmInquiry.update.mockResolvedValueOnce({ id: "i1", handleStatus: "open", handledAt: null, handleNote: null });
    await patch({ handleStatus: "open" });
    expect(db.dmInquiry.update.mock.calls[1][0].data).toMatchObject({ handleStatus: "open", handledAt: null, handledById: null });
  });
  it("ロック後に担当が外れていたら 404 で更新しない", async () => {
    guard.requireSaleDmWriteAccess.mockResolvedValueOnce({ session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
    db.dmInquiry.findUnique
      .mockResolvedValueOnce({ id: "i1", draft: { propertyId: "p1", campaign: { createdBy: "u1" }, property: { createdBy: "x", assignedTo: "u1" } } })
      .mockResolvedValueOnce({ draft: { propertyId: "p1", campaign: { createdBy: "u1" }, property: { createdBy: "x", assignedTo: "other" } } });
    const res = await patch({ handleStatus: "done" });
    expect(res.status).toBe(404);
    expect(lockPropertyRow).toHaveBeenCalledWith(db, "p1");
    expect(db.dmInquiry.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("ロック後に作成者が変わっていたら 404", async () => {
    db.dmInquiry.findUnique
      .mockResolvedValueOnce(FOUND)
      .mockResolvedValueOnce({ draft: { propertyId: "p1", campaign: { createdBy: "other" }, property: { createdBy: "u1", assignedTo: null } } });
    const res = await patch({ handleStatus: "done" });
    expect(res.status).toBe(404);
    expect(lockPropertyRow).toHaveBeenCalledWith(db, "p1");
    expect(db.dmInquiry.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
