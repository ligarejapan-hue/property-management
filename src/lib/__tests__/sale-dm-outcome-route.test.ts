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
  // 実 handleApiError を模倣: status を持つ error(ApiError / route-guard reject)はその status、
  // zod の ZodError(issues 配列)は 422、それ以外は 500。
  return {
    ApiError: MockApiError,
    // 実 parseJsonBody を模倣: 空ボディ→{}・不正JSON→ApiError(400)。
    parseJsonBody: vi.fn(async (r: Request) => {
      const t = await r.text();
      if (t.trim() === "") return {};
      try {
        return JSON.parse(t);
      } catch {
        throw new MockApiError(400, "リクエストボディが不正な JSON です", "INVALID_JSON");
      }
    }),
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

vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const draftUpdate = vi.fn();
  const draftCount = vi.fn();
  const propertyUpdate = vi.fn();
  const draftFindUnique = vi.fn();
  return {
    default: {
      dmRecipientDraft: { findUnique: draftFindUnique, update: draftUpdate, count: draftCount },
      property: { update: propertyUpdate },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          dmRecipientDraft: { update: draftUpdate, count: draftCount },
          property: { update: propertyUpdate },
        }),
      ),
    },
  };
});

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { PATCH } from "../../app/api/properties/sale-dm/drafts/[id]/outcome/route";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  property: { update: ReturnType<typeof vi.fn> };
};
const req = (b: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(b) });
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: true }] });
  pm.dmRecipientDraft.findUnique.mockResolvedValue({
    id: "r1",
    propertyId: "p1",
    deliveryStatus: "unknown",
    lpFirstAccessAt: null,
    phoneInquiryAt: null,
    status: "sent",
    campaign: { createdBy: "u1" },
  });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
  pm.dmRecipientDraft.count.mockResolvedValue(0);
  pm.property.update.mockResolvedValue({ id: "p1" });
});

describe("PATCH outcome", () => {
  it("delivered を記録し deliveryStatus/returnedAt を更新・物件は触らない", async () => {
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.deliveryStatus).toBe("delivered");
    expect(arg.data.returnedAt).toBeNull();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("電話反響を記録し outcome を inquiry に同期する", async () => {
    const res = await PATCH(req({ phoneInquiry: true }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.phoneInquiryAt).toBeInstanceOf(Date);
    expect(arg.data.outcome).toBe("inquiry");
  });

  it("電話反響を取り消すと outcome は LP の有無で再導出(LPなし→none)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1",
      propertyId: "p1",
      deliveryStatus: "delivered",
      lpFirstAccessAt: null,
      phoneInquiryAt: new Date(),
      status: "sent",
      campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ phoneInquiry: false }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.phoneInquiryAt).toBeNull();
    expect(arg.data.outcome).toBe("none");
  });

  it("returned_undeliverable を記録すると物件を no_send + dmUndeliverableAt にし監査する", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    const draftArg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(draftArg.data.deliveryStatus).toBe("returned_undeliverable");
    expect(draftArg.data.returnedAt).toBeInstanceOf(Date);
    const propArg = pm.property.update.mock.calls[0][0];
    expect(propArg.where.id).toBe("p1");
    expect(propArg.data.dmStatus).toBe("no_send");
    expect(propArg.data.dmUndeliverableAt).toBeInstanceOf(Date);
    expect(writeAuditLog).toHaveBeenCalled();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(audit.detail)).not.toContain("本文");
  });

  it("returned_other は物件連動しない", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_other" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("宛先不明から配達済み等へ訂正すると物件の dmUndeliverableAt を null クリア(dmStatus は据え置き)・監査", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "returned_undeliverable",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    const propArg = pm.property.update.mock.calls[0][0];
    expect(propArg.where.id).toBe("p1");
    expect(propArg.data.dmUndeliverableAt).toBeNull();
    // dmStatus は人の判断で戻す(clear-undeliverable と同じ方針)ため自動では触らない。
    expect(propArg.data.dmStatus).toBeUndefined();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.detail.undeliverableCleared).toBe(true);
  });

  it("同じ物件に未解決の宛先不明が他に残る場合は物件フラグを消さない(undeliverableCleared=false)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "returned_undeliverable",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    pm.dmRecipientDraft.count.mockResolvedValue(1); // 他に1件 returned_undeliverable が残存
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.undeliverableCleared).toBe(false);
  });

  it("宛先不明のまま(unchanged)や他状態間の訂正では物件を触らない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "delivered",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "unknown" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("不正な deliveryStatus は 422", async () => {
    const res = await PATCH(req({ deliveryStatus: "bogus" }) as never, ctx());
    expect(res.status).toBe(422);
  });

  it("不正な JSON ボディは 400(500 でなく)・更新しない", async () => {
    const res = await PATCH(new Request("http://x", { method: "PATCH", body: "{ broken" }) as never, ctx());
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("存在しない draft は 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(404);
  });

  it("他人のキャンペーン配下の draft は 404・副作用なし(横断アクセス防止)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "other-user" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(404);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("未送付(status!=sent)の draft への記録は 409・物件を触らない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "confirmed", campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(409);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("権限不足(requireSaleDmAccess が 403 throw)で 403・副作用なし", async () => {
    class MockApiError extends Error {
      status = 403;
      code = "FORBIDDEN";
    }
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new MockApiError("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("property:write 不足だと宛先不明連動(returned_undeliverable)は 403・副作用なし", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: false }] });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("property:write 不足でも物件連動しない記録(delivered/電話)は 200(下書きのみ更新)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: false }] });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff が作成/担当でない物件への宛先不明連動は 403・副作用なし(物件 record scope)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff でも担当物件なら宛先不明連動できる(200)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).toHaveBeenCalled();
  });

  it("field_staff は担当外物件の宛先には配達結果も記録できない(403・record scope を全 outcome 更新に適用)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff は担当外物件の宛先には電話反響も記録できない(403)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ phoneInquiry: true }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("field_staff でも担当物件なら配達結果を記録できる(200)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
  });
});
