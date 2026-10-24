/**
 * PATCH 添付の種類: 本人確認書類(identity_document)への変更・からの変更は、所有者の項目をすべて
 * 見られる人だけ(2026-10-24)。物件を編集できるだけの人が「その他に直す」で守りを外せない。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
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
vi.mock("@/lib/url-normalize", () => ({ normalizeFileUrlsInRecord: (r: unknown) => r }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    attachment: { findUnique: vi.fn(), findMany: vi.fn(async () => []), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a", ...data })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { PATCH } from "../route";

const pm = prisma as unknown as { attachment: { findUnique: Mock; update: Mock } };
const PROP = "11111111-1111-4111-8111-111111111111";
const ATT = "22222222-2222-4222-8222-222222222222";
const PROPERTY_WRITE = [{ resource: "property", action: "write", granted: true }];
const ALL_PII = [
  ...PROPERTY_WRITE,
  { resource: "owner", action: "read", granted: true },
  ...["owner_name", "owner_name_kana", "owner_address", "owner_phone", "owner_email", "owner_zip", "owner_note", "owner_corporate_number"].map(
    (resource) => ({ resource, action: "full", granted: true }),
  ),
];

function ctx() { return { params: Promise.resolve({ id: PROP, attachmentId: ATT }) }; }
function req(body: unknown) {
  const text = JSON.stringify(body);
  return new Request("http://t/", { method: "PATCH", body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
}
function att(docKind: string | null) {
  return {
    id: ATT, targetType: "property", targetId: PROP, isDeleted: false, type: "general",
    fileName: "免許証.jpg", docTitle: null, docKind, createdAt: new Date(2026, 9, 24),
    property: { createdBy: "u1", assignedTo: null, buildingName: "X", roomNo: null, address: "東京都…" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.attachment.findUnique.mockReset(); // Once で積んだ値を次のテストに残さない
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
});

describe("PATCH 添付の種類 — 本人確認書類", () => {
  it("★物件を編集できるだけの人は、本人確認書類を「その他」に直せない(403・守りを外せない)", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(PROPERTY_WRITE);
    pm.attachment.findUnique.mockResolvedValue(att("identity_document"));
    const res = await PATCH(req({ docKind: null }) as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("★物件を編集できるだけの人は、ほかの書類を本人確認書類にもできない(403)", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(PROPERTY_WRITE);
    pm.attachment.findUnique.mockResolvedValue(att("sales_contract"));
    const res = await PATCH(req({ docKind: "identity_document" }) as never, ctx() as never);
    expect(res.status).toBe(403);
  });

  it("所有者の項目をすべて見られる人は変えられる", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(ALL_PII);
    pm.attachment.findUnique.mockResolvedValue(att("identity_document"));
    const res = await PATCH(req({ docKind: "sales_contract" }) as never, ctx() as never);
    expect(res.status).toBe(200);
    expect(pm.attachment.update.mock.calls[0][0].data.docKind).toBe("sales_contract");
  });

  it("★ロックのあとに読み直した行が本人確認書類になっていれば 403(読んでからロックまでの間に権限のある人が変えた・同時操作)", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(PROPERTY_WRITE);
    pm.attachment.findUnique
      .mockResolvedValueOnce(att("sales_contract"))
      .mockResolvedValueOnce({ docKind: "identity_document", isDeleted: false, type: "general" });
    const res = await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
    // 2回目の読み直しはロック(FOR UPDATE)のあと
    const lockOrder = (prisma as unknown as { $queryRaw: Mock }).$queryRaw.mock.invocationCallOrder[0];
    expect(pm.attachment.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(lockOrder);
  });

  it("★ロックのあとに読み直した行が消えていれば 404(更新しない)", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(ALL_PII);
    pm.attachment.findUnique
      .mockResolvedValueOnce(att("identity_document"))
      .mockResolvedValueOnce({ docKind: "identity_document", isDeleted: true, type: "general" });
    const res = await PATCH(req({ docKind: "sales_contract" }) as never, ctx() as never);
    expect(res.status).toBe(404);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("本人確認書類に関わらない変更は今までどおり(物件を編集できる人で 200)", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(PROPERTY_WRITE);
    pm.attachment.findUnique.mockResolvedValue(att("sales_contract"));
    const res = await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    expect(res.status).toBe(200);
  });
});
