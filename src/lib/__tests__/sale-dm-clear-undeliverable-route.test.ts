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
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/[id]/clear-dm-undeliverable/route";

const pm = prismaMock as never as {
  property: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};
const req = (b: unknown = {}) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const ctx = (id = "p1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: true }] });
  pm.property.findUnique.mockResolvedValue({ id: "p1", dmUndeliverableAt: new Date(), dmStatus: "no_send" });
  pm.property.update.mockResolvedValue({ id: "p1" });
});

describe("POST clear-dm-undeliverable", () => {
  it("dmUndeliverableAt を null に戻し dmStatus は据え置き・監査する", async () => {
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const arg = pm.property.update.mock.calls[0][0];
    expect(arg.data.dmUndeliverableAt).toBeNull();
    expect(arg.data.dmStatus).toBeUndefined();
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it("空ボディ(解除のみの既定呼び出し)でも 200・dmUndeliverableAt を解除(request.json の 500 回避)", async () => {
    const res = await POST(new Request("http://x", { method: "POST" }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.property.update.mock.calls[0][0];
    expect(arg.data.dmUndeliverableAt).toBeNull();
    expect(arg.data.dmStatus).toBeUndefined();
  });

  it("不正な JSON ボディは 400(500 でなく)・更新しない", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: "{ broken" }) as never, ctx());
    expect(res.status).toBe(400);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("restoreDmStatus=send 指定時は dmStatus も戻す", async () => {
    const res = await POST(req({ restoreDmStatus: "send" }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.property.update.mock.calls[0][0];
    expect(arg.data.dmStatus).toBe("send");
  });

  it("存在しない物件は 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(404);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("不正な restoreDmStatus は 422", async () => {
    const res = await POST(req({ restoreDmStatus: "bogus" }) as never, ctx());
    expect(res.status).toBe(422);
  });

  it("権限不足で 403・副作用なし", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("property:write 不足で 403・更新しない(物件書込はwrite権限必須)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: false }] });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff が作成/担当でない物件を操作すると 403・更新しない", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.property.findUnique.mockResolvedValue({ id: "p1", dmUndeliverableAt: new Date(), dmStatus: "no_send", createdBy: "other", assignedTo: "other" });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff でも担当物件なら 200", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.property.findUnique.mockResolvedValue({ id: "p1", dmUndeliverableAt: new Date(), dmStatus: "no_send", createdBy: "other", assignedTo: "u1" });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).toHaveBeenCalled();
  });
});
