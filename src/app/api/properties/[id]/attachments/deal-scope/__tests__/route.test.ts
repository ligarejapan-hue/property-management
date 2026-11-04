import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * PUT /api/properties/[id]/attachments/deal-scope(添付の取引を決める・2026-11-04 案A)。
 * - 物件を編集できて取引を見られる人だけ。担当の範囲は親のロックで確かめる。
 * - この物件の添付・この物件の取引だけ。監査にファイル名を出さない。
 */

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string; name?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? (e?.name === "ZodError" ? 422 : 500) }),
  ),
}));
const perm = { propertyWrite: true, dealRead: true };
vi.mock("@/lib/permissions", () => ({
  hasPermission: (_p: unknown, resource: string, action: string) => {
    if (resource === "property" && action === "write") return perm.propertyWrite;
    if (resource === "deal" && action === "read") return perm.dealRead;
    return false;
  },
}));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ writeAuditLog: (...a: unknown[]) => audit(...a) }));
const lock = vi.fn();
const access = vi.fn();
vi.mock("@/lib/property-record-guard", () => ({
  assertPropertyRecordAccess: (...a: unknown[]) => access(...a),
  lockPropertyRecordForWrite: (...a: unknown[]) => lock(...a),
}));
vi.mock("@/lib/import-body-size", () => ({ assertImportJsonBodySize: vi.fn() }));

const tx = {
  attachment: { findMany: vi.fn(), update: vi.fn() },
  deal: { findMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({
  default: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));

import { NextRequest } from "next/server";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { PUT } from "../route";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const D1 = "33333333-3333-4333-8333-333333333333";

const call = async (items: unknown) => {
  const req = new NextRequest("http://localhost/api/properties/p1/attachments/deal-scope", {
    method: "PUT",
    body: JSON.stringify({ items }),
  });
  const res = await PUT(req, { params: Promise.resolve({ id: "p1" }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  perm.propertyWrite = true;
  perm.dealRead = true;
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  tx.attachment.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id })),
  );
  tx.deal.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id })),
  );
});

describe("PUT deal-scope", () => {
  it("取引・共通・未区分に戻すを書く(親をロックしてから)", async () => {
    const { status, body } = await call([
      { attachmentId: A1, scope: D1 },
      { attachmentId: A2, scope: "common" },
    ]);
    expect(status).toBe(200);
    expect(body.updated).toBe(2);
    expect(lock).toHaveBeenCalledWith(tx, "p1", { id: "u1", role: "office_staff" });
    expect(tx.attachment.update).toHaveBeenCalledWith({ where: { id: A1 }, data: { dealId: D1, dealCommon: false } });
    expect(tx.attachment.update).toHaveBeenCalledWith({ where: { id: A2 }, data: { dealId: null, dealCommon: true } });
    // 添付・取引はこの物件のものだけを探す
    const aw = tx.attachment.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(aw.where).toMatchObject({ targetType: "property", targetId: "p1", isDeleted: false });
    const dw = tx.deal.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(dw.where).toMatchObject({ propertyId: "p1" });
    // 監査はファイル名なし・件数だけ
    const detail = (audit.mock.calls[0][0] as { detail: Record<string, unknown> }).detail;
    expect(detail).toEqual({ propertyId: "p1", updatedCount: 2, toDeal: 1, toCommon: 1, toUnset: 0 });
  });

  it("null は未区分に戻す", async () => {
    await call([{ attachmentId: A1, scope: null }]);
    expect(tx.attachment.update).toHaveBeenCalledWith({ where: { id: A1 }, data: { dealId: null, dealCommon: false } });
  });

  it("物件を編集できない・取引を見られない人は 403(書かない)", async () => {
    perm.dealRead = false;
    expect((await call([{ attachmentId: A1, scope: "common" }])).status).toBe(403);
    perm.dealRead = true;
    perm.propertyWrite = false;
    expect((await call([{ attachmentId: A1, scope: "common" }])).status).toBe(403);
    expect(tx.attachment.update).not.toHaveBeenCalled();
  });

  it("ほかの物件の取引・この物件に無い添付は断る(書かない)", async () => {
    tx.deal.findMany.mockResolvedValue([]);
    expect((await call([{ attachmentId: A1, scope: D1 }])).status).toBe(422);
    tx.attachment.findMany.mockResolvedValue([]);
    expect((await call([{ attachmentId: A1, scope: "common" }])).status).toBe(404);
    expect(tx.attachment.update).not.toHaveBeenCalled();
  });

  it("読めない指定・同じ添付が2回は断る", async () => {
    expect((await call([{ attachmentId: A1, scope: "xyz" }])).status).toBe(422);
    expect((await call([{ attachmentId: A1, scope: "common" }, { attachmentId: A1, scope: null }])).status).toBe(422);
    expect(tx.attachment.update).not.toHaveBeenCalled();
  });
});
