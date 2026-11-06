import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// POST /api/properties/[id]/parcel-detach — この筆を別の物件にする(2026-11-06 案A 3回目の3つ目)。

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
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn((_p: unknown, _r: string, _a: string) => true) }));
vi.mock("@/lib/permissions", () => ({ hasPermission }));
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));

const tx = {
  property: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  propertyOwner: { findMany: vi.fn(), createMany: vi.fn() },
  changeLog: { create: vi.fn() },
  comment: { create: vi.fn() },
  deal: { findMany: vi.fn() },
  $queryRaw: vi.fn(async () => []),
};
vi.mock("@/lib/prisma", () => ({ default: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { POST } from "../parcel-detach/route";

const PID = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: PID }) };
const row = (id: string, kind: "land" | "building", number: string) => ({ id, kind, location: null, number, realEstateNumber: null, area: 25 });
const CUR = {
  version: 4, createdBy: "u1", assignedTo: "u2", propertyType: "house", address: "架空市1", postalCode: "100-0001",
  extraParcels: [row("a", "land", "1番2"), row("b", "building", "1番2の1")], businessType: "resale",
};
const req = (body: unknown) => new Request(`http://x/api/properties/${PID}/parcel-detach`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockImplementation(() => true);
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  tx.property.findUnique.mockResolvedValue(CUR);
  tx.property.updateMany.mockResolvedValue({ count: 1 });
  tx.property.create.mockResolvedValue({ id: NEW });
  tx.propertyOwner.findMany.mockResolvedValue([{ ownerId: "o1", relationship: null, isPrimary: true, startDate: null, endDate: null }]);
  tx.$queryRaw.mockResolvedValue([]);
  tx.deal.findMany.mockResolvedValue([]);
});

describe("この筆を別の物件にする", () => {
  it("★行を外し、新しい物件を作り、所有者のつながりを写し、両方にコメント(リンク)を残す", async () => {
    const res = await POST(req({ version: 4, rowId: "a" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ newPropertyId: NEW, ownersCopied: 1, ownersSkipped: false });
    expect(assertNotEditLockedByOther).toHaveBeenCalledWith(tx, expect.objectContaining({ resourceType: "property", resourceId: PID }));
    expect(tx.property.updateMany).toHaveBeenCalledWith({ where: { id: PID, version: 4, registryStatus: { not: "scheduled" } }, data: { extraParcels: [CUR.extraParcels[1]], version: { increment: 1 } } });
    expect(tx.property.create.mock.calls[0][0].data).toMatchObject({
      propertyType: "land", address: "架空市1", postalCode: "100-0001", lotNumber: "1番2", landArea: 25, businessType: "resale", assignedTo: "u2", createdBy: "u1",
    });
    expect(tx.propertyOwner.createMany).toHaveBeenCalledWith({ data: [{ ownerId: "o1", relationship: null, isPrimary: true, startDate: null, endDate: null, propertyId: NEW }] });
    const bodies = tx.comment.create.mock.calls.map((c) => c[0].data);
    expect(bodies[0]).toMatchObject({ propertyId: PID, body: expect.stringContaining(`/properties/${NEW}`) });
    expect(bodies[1]).toMatchObject({ propertyId: NEW, body: expect.stringContaining(`/properties/${PID}`) });
    // ⚠監査に地番・所在を出さない。
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toMatch(/番|架空/);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "property_parcel_detach", targetId: PID }));
  });
  it("★謄本の自動取得中は止める(取得の対象の行を動かさない・何も書かない)", async () => {
    tx.property.findUnique.mockResolvedValue({ ...CUR, registryStatus: "scheduled" });
    const res = await POST(req({ version: 4, rowId: "a" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("REGISTRY_FETCH_IN_PROGRESS");
    expect(tx.property.create).not.toHaveBeenCalled();
  });
  it("全部(null)を扱っている取引の数を返す(その取引からは行が外れる=知らせる)", async () => {
    tx.deal.findMany.mockResolvedValue([{ targetParcels: null }, { targetParcels: ["main:land"] }, { targetParcels: null }]);
    expect(await (await POST(req({ version: 4, rowId: "a" }), ctx)).json()).toMatchObject({ dealsCoveringAll: 2 });
  });
  it("★所有者を物件の行より先にロックする・ロックのあとで所有者が増えていたら止める(@codex P2)", async () => {
    await POST(req({ version: 4, rowId: "a" }), ctx);
    const ownerLock = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(ownerLock).toBeLessThan((lockPropertyRow as Mock).mock.invocationCallOrder[0]);
    vi.clearAllMocks();
    tx.property.findUnique.mockResolvedValue(CUR);
    tx.property.updateMany.mockResolvedValue({ count: 1 });
    tx.property.create.mockResolvedValue({ id: NEW });
    tx.deal.findMany.mockResolvedValue([]);
    tx.propertyOwner.findMany
      .mockResolvedValueOnce([{ ownerId: "o1" }])
      .mockResolvedValueOnce([{ ownerId: "o1", relationship: null, isPrimary: true, startDate: null, endDate: null }, { ownerId: "o2", relationship: null, isPrimary: false, startDate: null, endDate: null }]);
    const res = await POST(req({ version: 4, rowId: "a" }), ctx);
    expect(res.status).toBe(409);
    expect(tx.propertyOwner.createMany).not.toHaveBeenCalled();
  });
  it("所有者を書けない人は、所有者のつながりを写さない(物件は作る)", async () => {
    hasPermission.mockImplementation((_p, resource) => resource !== "owner");
    const body = await (await POST(req({ version: 4, rowId: "a" }), ctx)).json();
    expect(body).toMatchObject({ ownersCopied: 0, ownersSkipped: true });
    expect(tx.propertyOwner.createMany).not.toHaveBeenCalled();
  });
  it("★その行を選んでいる取引があれば止める(取引の行をロックしてから見る・何も書かない)", async () => {
    tx.deal.findMany.mockResolvedValue([{ targetParcels: ["main:land", "a"] }]);
    const res = await POST(req({ version: 4, rowId: "a" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("PARCEL_IN_DEAL");
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    expect(tx.property.create).not.toHaveBeenCalled();
  });
  it("止める: 権限なし 403・担当外 404・版違い 409・区分 422・無い行 422・書き込み0件 409(物件を作らない)", async () => {
    hasPermission.mockImplementation(() => false);
    expect((await POST(req({ version: 4, rowId: "a" }), ctx)).status).toBe(403);
    hasPermission.mockImplementation(() => true);
    (getApiSession as Mock).mockResolvedValue({ id: "u9", role: "field_staff" });
    expect((await POST(req({ version: 4, rowId: "a" }), ctx)).status).toBe(404);
    (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
    expect((await POST(req({ version: 3, rowId: "a" }), ctx)).status).toBe(409);
    tx.property.findUnique.mockResolvedValue({ ...CUR, propertyType: "apartment_unit" });
    expect((await POST(req({ version: 4, rowId: "a" }), ctx)).status).toBe(422);
    tx.property.findUnique.mockResolvedValue(CUR);
    expect((await POST(req({ version: 4, rowId: "zzz" }), ctx)).status).toBe(422);
    tx.property.updateMany.mockResolvedValue({ count: 0 });
    expect((await POST(req({ version: 4, rowId: "a" }), ctx)).status).toBe(409);
    expect(tx.property.create).not.toHaveBeenCalled();
  });
});
