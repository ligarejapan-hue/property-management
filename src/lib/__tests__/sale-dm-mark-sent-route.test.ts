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
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const draftUpdate = vi.fn();
  const dmLogCreate = vi.fn();
  const draftFindUnique = vi.fn();
  return {
    default: {
      dmRecipientDraft: { findUnique: draftFindUnique, update: draftUpdate },
      propertyDmLog: { create: dmLogCreate },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          dmRecipientDraft: { update: draftUpdate },
          propertyDmLog: { create: dmLogCreate },
        }),
      ),
    },
  };
});

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/sale-dm/drafts/[id]/mark-sent/route";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  propertyDmLog: { create: ReturnType<typeof vi.fn> };
};
const req = () => new Request("http://x", { method: "POST", body: "{}" });
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" } });
  pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", propertyId: "p1", status: "confirmed" });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
  pm.propertyDmLog.create.mockResolvedValue({ id: "log1" });
});

describe("POST mark-sent", () => {
  it("confirmed の draft を sent にし PropertyDmLog を作る・no-store・監査", async () => {
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const draftArg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(draftArg.data.status).toBe("sent");
    expect(draftArg.data.sentAt).toBeInstanceOf(Date);
    const logArg = pm.propertyDmLog.create.mock.calls[0][0];
    expect(logArg.data.propertyId).toBe("p1");
    expect(logArg.data.sentBy).toBe("u1");
    expect(logArg.data.method).toBe("sale_dm");
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it("既に sent の draft は冪等(再 create しない)で 200", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", propertyId: "p1", status: "sent" });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("draft が draft(未確定)状態なら 409", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", propertyId: "p1", status: "draft" });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(409);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("存在しない draft は 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(404);
  });

  it("権限不足で 403・副作用なし", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });
});
