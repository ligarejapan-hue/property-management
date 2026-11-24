import { vi, describe, it, expect, beforeEach } from "vitest";

// 「追客を止める」と追客の様子の API(物件・査定申込)。設計 2026-11-16 §6 PR2。

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

const h = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  const session = { id: "u1", role: "admin" };
  return {
    MockApiError,
    session,
    getApiSession: vi.fn(async () => session as { id: string; role: string }),
    getUserPermissions: vi.fn(async () => [] as unknown[]),
    getOwnerDisplayConfig: vi.fn(async () => ({ email: "full" })),
    hasPermission: vi.fn<(p: unknown, r: string, a: string) => boolean>(() => true),
    requireSaleDmWriteAccess: vi.fn(async () => ({ session, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } })),
  };
});

vi.mock("@/lib/api-helpers", () => ({
  ApiError: h.MockApiError,
  getApiSession: h.getApiSession,
  getUserPermissions: h.getUserPermissions,
  getOwnerDisplayConfig: h.getOwnerDisplayConfig,
  handleApiError: (e: unknown) => {
    const x = e as { status?: unknown; code?: unknown; issues?: unknown };
    if (typeof x?.status === "number") return Response.json({ error: { code: x.code } }, { status: x.status });
    if (Array.isArray(x?.issues)) return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
    return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
  },
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: h.hasPermission }));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: (s: { id: string; role: string }, p: { createdBy: string | null; assignedTo: string | null }) =>
    s.role !== "field_staff" || p.createdBy === s.id || p.assignedTo === s.id,
}));
vi.mock("@/lib/dm-export", () => ({ isPlainOwnerLevel: (l: string) => l === "full" }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmWriteAccess: h.requireSaleDmWriteAccess,
  filterDraftsByFieldStaffScope: (
    drafts: Array<{ property?: { createdBy?: string | null; assignedTo?: string | null } | null }>,
    s: { id: string; role?: string },
  ) =>
    s?.role === "field_staff"
      ? drafts.filter((d) => d.property && (d.property.createdBy === s.id || d.property.assignedTo === s.id))
      : drafts,
}));

const db = vi.hoisted(() => {
  const self = {
    property: { findUnique: vi.fn() },
    dmInquiry: { findUnique: vi.fn() },
    leadFollowup: { findUnique: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(self)),
  };
  return self;
});
vi.mock("@/lib/prisma", () => ({ default: db }));

import { GET as propertyGet, POST as propertyPost } from "@/app/api/properties/[id]/lead-followup/route";
import { POST as inquiryStop } from "@/app/api/properties/sale-dm/inquiries/[inquiryId]/followup-stop/route";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";

const PID = "0b9c7f1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b";
const pctx = { params: Promise.resolve({ id: PID }) };
const ictx = { params: Promise.resolve({ inquiryId: "inq-1" }) };
const req = () => new Request("http://x/api", { method: "POST" });
const property = { id: PID, createdBy: "u9", assignedTo: null, introductionRoute: "bulk_assessment", leadFollowup: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.getApiSession.mockResolvedValue(h.session);
  h.hasPermission.mockReturnValue(true);
  h.getOwnerDisplayConfig.mockResolvedValue({ email: "full" });
  h.requireSaleDmWriteAccess.mockResolvedValue({ session: h.session, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" } });
  db.property.findUnique.mockResolvedValue(property);
  db.leadFollowup.findUnique.mockResolvedValue(null);
  db.leadFollowup.updateMany.mockResolvedValue({ count: 0 });
  db.leadFollowup.createMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/properties/[id]/lead-followup", () => {
  it("物件を読めなければ 403・物件が無ければ 404・担当外の現地担当は 403", async () => {
    h.hasPermission.mockReturnValueOnce(false);
    expect((await propertyGet(req(), pctx)).status).toBe(403);
    db.property.findUnique.mockResolvedValueOnce(null);
    expect((await propertyGet(req(), pctx)).status).toBe(404);
    h.getApiSession.mockResolvedValueOnce({ id: "u1", role: "field_staff" });
    expect((await propertyGet(req(), pctx)).status).toBe(403);
    expect(db.leadFollowup.findUnique).not.toHaveBeenCalled();
  });

  it("所有者のメールを見られない人には visible=false だけ(追客の行は読まない)", async () => {
    h.getOwnerDisplayConfig.mockResolvedValueOnce({ email: "masked" });
    const res = await propertyGet(req(), pctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ visible: false, followup: null });
    expect(db.leadFollowup.findUnique).not.toHaveBeenCalled();
  });

  it("見られる人には様子を返す(行が無ければ「まだ送っていません」)", async () => {
    const res = await propertyGet(req(), pctx);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.visible).toBe(true);
    expect(body.followup).toMatchObject({ state: "none", canStop: true });
    expect(db.leadFollowup.findUnique.mock.calls[0][0].where).toEqual({ propertyId: PID });
  });

  it("id が uuid でなければ 422", async () => {
    expect((await propertyGet(req(), { params: Promise.resolve({ id: "x" }) })).status).toBe(422);
  });
});

describe("POST /api/properties/[id]/lead-followup(追客を止める)", () => {
  it("物件を書けない・メールを見られない人は 403(何も書かない)", async () => {
    h.hasPermission.mockReturnValueOnce(false);
    expect((await propertyPost(req(), pctx)).status).toBe(403);
    h.getOwnerDisplayConfig.mockResolvedValueOnce({ email: "masked" });
    expect((await propertyPost(req(), pctx)).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("物件行をロックしてから止める・監査は定型の項目だけ", async () => {
    db.leadFollowup.findUnique.mockResolvedValueOnce({
      status: "stopped", stopReason: "manual", stoppedAt: new Date("2026-11-18T03:00:00Z"), stoppedBy: { name: "担当A" }, sends: [],
    });
    const res = await propertyPost(req(), pctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("created");
    expect(body.followup).toMatchObject({ state: "stopped", canStop: false, stopped: { by: "担当A" } });
    expect(lockPropertyRow).toHaveBeenCalledWith(db, PID);
    expect(vi.mocked(lockPropertyRow).mock.invocationCallOrder[0]).toBeLessThan(db.leadFollowup.updateMany.mock.invocationCallOrder[0]);
    expect(db.leadFollowup.createMany.mock.calls[0][0].data[0]).toMatchObject({ targetType: "property", propertyId: PID, stoppedById: "u1" });
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "u1",
      action: "lead_followup_manual_stop",
      targetTable: "properties",
      targetId: PID,
      detail: { target: "property", result: "created" },
    });
  });

  it("ロックの後に物件が消えていたら 404・担当が外れていたら 403(止めない)", async () => {
    db.property.findUnique.mockResolvedValueOnce(property).mockResolvedValueOnce(null);
    expect((await propertyPost(req(), pctx)).status).toBe(404);
    h.getApiSession.mockResolvedValueOnce({ id: "u1", role: "field_staff" });
    db.property.findUnique.mockResolvedValueOnce({ ...property, createdBy: "u1" }).mockResolvedValueOnce(property);
    expect((await propertyPost(req(), pctx)).status).toBe(403);
    expect(db.leadFollowup.updateMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/properties/[id]/lead-followup(対象の導入ルートでない物件)", () => {
  it("追客の行が無ければ 409(止めた印を作らない)", async () => {
    for (const route of ["reception_csv", "field_survey", "manual_entry", "other", null]) {
      vi.clearAllMocks();
      db.property.findUnique.mockResolvedValue({ ...property, introductionRoute: route });
      const res = await propertyPost(req(), pctx);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("NOT_FOLLOWUP_TARGET");
      expect(db.leadFollowup.updateMany).not.toHaveBeenCalled();
      expect(db.leadFollowup.createMany).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
    }
  });

  it("DM反響・電話問い合わせ・Web問い合わせ・紹介の物件は、行が無くても止めた印を作れる(2026-11-24 対象を広げた)", async () => {
    for (const route of ["dm_response", "phone_inquiry", "web_inquiry", "referral"]) {
      db.property.findUnique.mockResolvedValue({ ...property, introductionRoute: route });
      const res = await propertyPost(req(), pctx);
      expect(res.status).toBe(200);
    }
  });

  it("すでに追客の行があれば(導入ルートが後で変わっても)止められる", async () => {
    db.property.findUnique.mockResolvedValue({ ...property, introductionRoute: "dm", leadFollowup: { id: "lf1" } });
    db.leadFollowup.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await propertyPost(req(), pctx);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("stopped");
  });
});

describe("POST /api/properties/sale-dm/inquiries/[inquiryId]/followup-stop", () => {
  const inquiry = (createdBy: string | null) => ({
    id: "inq-1",
    draft: { propertyId: PID, property: { createdBy, assignedTo: null } },
  });

  it("申込のメールを見られない人は 403(何も読まない・書かない)", async () => {
    h.requireSaleDmWriteAccess.mockResolvedValueOnce({ session: h.session, permissions: [], ownerDisplayConfig: { phone: "full", email: "masked" } });
    expect((await inquiryStop(req(), ictx)).status).toBe(403);
    expect(db.dmInquiry.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("無い申込・担当外の現地担当は 404", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce(null);
    expect((await inquiryStop(req(), ictx)).status).toBe(404);
    h.requireSaleDmWriteAccess.mockResolvedValueOnce({
      session: { id: "u1", role: "field_staff" }, permissions: [], ownerDisplayConfig: { phone: "full", email: "full" },
    });
    db.dmInquiry.findUnique.mockResolvedValueOnce(inquiry("u9"));
    expect((await inquiryStop(req(), ictx)).status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("物件配下の申込は物件行をロックし、読み直してから止める・監査は定型の項目だけ", async () => {
    db.dmInquiry.findUnique.mockResolvedValue(inquiry("u9"));
    db.leadFollowup.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await inquiryStop(req(), ictx);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("stopped");
    expect(lockPropertyRow).toHaveBeenCalledWith(db, PID);
    expect(db.dmInquiry.findUnique).toHaveBeenCalledTimes(2);
    expect(db.leadFollowup.updateMany.mock.calls[0][0].where).toEqual({ inquiryId: "inq-1", status: { in: ["active", "sending"] } });
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "u1",
      action: "lead_followup_manual_stop",
      targetTable: "dm_inquiries",
      targetId: "inq-1",
      detail: { target: "inquiry", result: "stopped" },
    });
  });

  it("広告ページの申込(物件なし)はロックせずに止める", async () => {
    db.dmInquiry.findUnique.mockResolvedValue({ id: "inq-1", draft: null });
    expect((await inquiryStop(req(), ictx)).status).toBe(200);
    expect(lockPropertyRow).not.toHaveBeenCalled();
  });

  it("ロックの間に申込の物件が変わっていたら 404(止めない)", async () => {
    db.dmInquiry.findUnique.mockResolvedValueOnce(inquiry("u9")).mockResolvedValueOnce({
      draft: { propertyId: "other", property: { createdBy: "u9", assignedTo: null } },
    });
    expect((await inquiryStop(req(), ictx)).status).toBe(404);
    expect(db.leadFollowup.updateMany).not.toHaveBeenCalled();
  });
});
