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
import { POST } from "../route";

const pm = prisma as unknown as { attachment: { findUnique: Mock; update: Mock } };
const PROP = "11111111-1111-4111-8111-111111111111";
const ATT = "22222222-2222-4222-8222-222222222222";
function ctx() { return { params: Promise.resolve({ id: PROP, attachmentId: ATT }) }; }

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
  pm.attachment.findUnique.mockResolvedValue({ id: ATT, targetType: "property", targetId: PROP, isDeleted: true, property: { createdBy: "u1", assignedTo: null } });
  pm.attachment.update.mockResolvedValue({});
});

describe("POST restore attachment", () => {
  it("property:write が無ければ 403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValueOnce([]);
    const res = await POST({} as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("未削除（isDeleted=false）の添付は 404", async () => {
    pm.attachment.findUnique.mockResolvedValueOnce({ id: ATT, targetType: "property", targetId: PROP, isDeleted: false, property: { createdBy: "u1", assignedTo: null } });
    const res = await POST({} as never, ctx() as never);
    expect(res.status).toBe(404);
  });

  it("field_staff が担当外なら 403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValueOnce({ id: "other", role: "field_staff" });
    const res = await POST({} as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("復元: isDeleted=false, deletedAt=null にする", async () => {
    const res = await POST({} as never, ctx() as never);
    expect(res.status).toBe(200);
    expect(pm.attachment.update.mock.calls[0][0].data).toEqual({ isDeleted: false, deletedAt: null });
  });

  it("owner 添付（targetType=owner）を property URL で restore → 404・update 不呼び出し", async () => {
    pm.attachment.findUnique.mockResolvedValueOnce({ id: ATT, targetType: "owner", targetId: PROP, isDeleted: true, property: null });
    const res = await POST({} as never, ctx() as never);
    expect(res.status).toBe(404);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("property 添付だが property relation が null → 403・update 不呼び出し", async () => {
    pm.attachment.findUnique.mockResolvedValueOnce({ id: ATT, targetType: "property", targetId: PROP, isDeleted: true, property: null });
    const res = await POST({} as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });
});
