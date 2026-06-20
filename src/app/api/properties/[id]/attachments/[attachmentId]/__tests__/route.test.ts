import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { attachment: { findUnique: vi.fn(), update: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DELETE } from "../route";

const pm = prisma as unknown as { attachment: { findUnique: Mock; update: Mock } };
const PROP = "11111111-1111-4111-8111-111111111111";
const ATT = "22222222-2222-4222-8222-222222222222";

function ctx() { return { params: Promise.resolve({ id: PROP, attachmentId: ATT }) }; }

describe("DELETE attachment soft-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
    (getUserPermissions as unknown as Mock).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    pm.attachment.findUnique.mockResolvedValue({ id: ATT, targetId: PROP, isDeleted: false, fileName: "a.pdf", property: { createdBy: "u1", assignedTo: null } });
    pm.attachment.update.mockResolvedValue({});
  });

  it("soft-delete 時に isDeleted=true と deletedAt(Date) を記録する", async () => {
    const res = await DELETE({} as never, ctx() as never);
    expect(res.status).toBe(200);
    const arg = pm.attachment.update.mock.calls[0][0];
    expect(arg.data.isDeleted).toBe(true);
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
  });
});
