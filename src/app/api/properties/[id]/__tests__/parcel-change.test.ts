import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// POST /api/properties/[id]/parcel-change — 分筆・合筆の記録(2026-11-06 案A 3回目の2つ目)。

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
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string; issues?: unknown }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? (e?.issues ? 400 : 500) }),
  ),
}));
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/permissions", () => ({ hasPermission }));
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));
vi.mock("@/lib/random-id", () => {
  let n = 0;
  return { safeRandomId: () => `new${++n}` };
});

const tx = {
  property: { findUnique: vi.fn(), updateMany: vi.fn() },
  changeLog: { createMany: vi.fn() },
  comment: { create: vi.fn() },
  deal: { findMany: vi.fn(), update: vi.fn() },
  $queryRaw: vi.fn(async () => []),
};
vi.mock("@/lib/prisma", () => ({ default: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { POST } from "../parcel-change/route";

const PID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: PID }) };
const row = (id: string, number: string, location: string | null = null) => ({ id, kind: "land", location, number, realEstateNumber: null, area: null });
const CUR = {
  version: 4, createdBy: "u1", assignedTo: null, propertyType: "land", lotNumber: "1番1", registryStatus: "none",
  extraParcels: [row("a", "2番", "架空町二丁目")],
};
const req = (body: unknown) => new Request(`http://x/api/properties/${PID}/parcel-change`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) as never;
const split = (o: Record<string, unknown> = {}) => ({ op: "split", version: 4, source: "main:land", pieces: [{ number: "1番1", area: "100" }, { number: "1番5", area: null }], ...o });

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockReturnValue(true);
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  tx.property.findUnique.mockResolvedValue(CUR);
  tx.property.updateMany.mockResolvedValue({ count: 1 });
  tx.deal.findMany.mockResolvedValue([]);
});

describe("分筆・合筆の記録", () => {
  it("★分筆: 鍵を確かめてから書く・地番と行・変更履歴・コメント(記録した人)・版を上げる", async () => {
    const res = await POST(req(split()), ctx);
    expect(res.status).toBe(200);
    expect(lockPropertyRow).toHaveBeenCalled();
    expect(assertNotEditLockedByOther).toHaveBeenCalledWith(tx, expect.objectContaining({ resourceType: "property", resourceId: PID, userId: "u1" }));
    expect(tx.property.updateMany).toHaveBeenCalledWith({
      where: { id: PID, version: 4 },
      data: { extraParcels: [row("new1", "1番5"), CUR.extraParcels[0]].map((r, i) => (i === 0 ? { ...r, area: null } : r)), version: { increment: 1 } },
    });
    expect(tx.comment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ propertyId: PID, authorId: "u1", body: "分筆を記録しました：土地 1番1 → 1番1（100㎡）・1番5" }) });
    expect(tx.changeLog.createMany.mock.calls[0][0].data.map((l: { fieldName: string }) => l.fieldName)).toEqual(["extraParcels"]);
    // ⚠監査に地番を出さない。
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "property_parcel_split", detail: { parcels: 2, retargetedDeals: 0 } }));
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain("番");
  });
  it("★分けた筆を選んでいた取引には新しい筆を足す(版も上げる)・選んでいない取引は触らない", async () => {
    tx.deal.findMany.mockResolvedValue([{ id: "d1", targetParcels: ["main:land"] }, { id: "d2", targetParcels: ["a"] }]);
    const body = await (await POST(req(split()), ctx)).json();
    expect(body.retargetedDeals).toBe(1);
    expect(tx.deal.update).toHaveBeenCalledTimes(1);
    // 取引の行は読む前にロックする。
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.deal.findMany.mock.invocationCallOrder[0]);
    expect(tx.deal.update.mock.calls[0][0]).toMatchObject({ where: { id: "d1" }, data: { targetParcels: ["main:land", expect.stringMatching(/^new/)], version: { increment: 1 } } });
  });
  it("合筆: 1筆目の地番を書き換え、地番の変更履歴も残す", async () => {
    const res = await POST(req({ op: "merge", version: 4, keys: ["main:land", "a"], number: "1番", area: null }), ctx);
    expect(res.status).toBe(200);
    expect(tx.property.updateMany.mock.calls[0][0].data).toMatchObject({ lotNumber: "1番", extraParcels: [] });
    expect(tx.changeLog.createMany.mock.calls[0][0].data.map((l: { fieldName: string }) => l.fieldName)).toEqual(["lotNumber", "extraParcels"]);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "property_parcel_merge" }));
  });
  it("★謄本の自動取得中は、地番を変える記録を 409 で止める(書き込みの条件にも入れる)", async () => {
    tx.property.findUnique.mockResolvedValue({ ...CUR, registryStatus: "scheduled" });
    expect((await POST(req({ op: "merge", version: 4, keys: ["main:land", "a"], number: "1番", area: null }), ctx)).status).toBe(409);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    // 1筆目の地番が変わらない記録(足した行の分筆)は止めない。
    expect((await POST(req(split({ source: "a", pieces: [{ number: "2番1", area: null }, { number: "2番2", area: null }] })), ctx)).status).toBe(200);
    expect(tx.property.updateMany.mock.calls[0][0].where).toEqual({ id: PID, version: 4 });
  });
  it("止める: 権限なし 403・担当外 404・版違い 409・区分 422・分けられない値 422・書き込み0件 409", async () => {
    hasPermission.mockReturnValue(false);
    expect((await POST(req(split()), ctx)).status).toBe(403);
    hasPermission.mockReturnValue(true);
    (getApiSession as Mock).mockResolvedValue({ id: "u9", role: "field_staff" });
    expect((await POST(req(split()), ctx)).status).toBe(404);
    (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
    expect((await POST(req(split({ version: 3 })), ctx)).status).toBe(409);
    tx.property.findUnique.mockResolvedValue({ ...CUR, propertyType: "apartment_unit" });
    expect((await POST(req(split()), ctx)).status).toBe(422);
    tx.property.findUnique.mockResolvedValue(CUR);
    expect((await POST(req(split({ pieces: [{ number: "1番1", area: null }, { number: "1-1", area: null }] })), ctx)).status).toBe(422);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    tx.property.updateMany.mockResolvedValue({ count: 0 });
    expect((await POST(req(split()), ctx)).status).toBe(409);
    expect(tx.comment.create).not.toHaveBeenCalled();
  });
});
