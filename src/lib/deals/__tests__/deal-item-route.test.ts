import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { recordChangesInTx } = vi.hoisted(() => ({ recordChangesInTx: vi.fn() }));
vi.mock("@/lib/change-log", async (orig) => ({ ...(await orig<typeof import("@/lib/change-log")>()), recordChangesInTx }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
    property: { findUnique: vi.fn(async () => null) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PROP_ID, USER_ID, DEAL_PERMS } from "./route-mocks";
import { GET, PATCH } from "../../../app/api/deals/[id]/route";
import { POST as REFRESH } from "../../../app/api/deals/[id]/refresh-property/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn; updateMany: Fn };
  property: { findUnique: Fn };
  user: { findUnique: Fn };
};
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const detailRow = {
  id: DEAL_ID, dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: PROP_ID, propertyKind: "unit", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null, price: BigInt(30000000), buildingTax: null, deposit: null,
  taxRateBp: 1000, propertySnapshot: { roomNo: "201" }, counterpartyBroker: {}, version: 3,
  createdAt: new Date("2026-10-24T00:00:00Z"), updatedAt: new Date("2026-10-24T00:00:00Z"), parties: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue(detailRow);
  pm.deal.updateMany.mockResolvedValue({ count: 1 });
  pm.user.findUnique.mockResolvedValue({ isActive: true });
});

describe("GET /api/deals/[id]", () => {
  it("金額は数・写しは空で補う・物件を開けるか", async () => {
    pm.property.findUnique.mockResolvedValue({ createdBy: "u-office", assignedTo: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.deal.price).toBe(30000000);
    expect(body.deal.propertySnapshot.roomNo).toBe("201");
    expect(body.deal.propertySnapshot.address).toBeNull();
    expect(body.canOpenProperty).toBe(true);
  });
  it("現地担当で担当外の物件なら、物件は開けない(取引は見られる)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.property.findUnique.mockResolvedValue({ createdBy: "other", assignedTo: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(false);
  });
  it("無ければ 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });
});

describe("PATCH /api/deals/[id]", () => {
  it("版の番号で書き、変更履歴と監査(項目名だけ)を残す", async () => {
    const res = await PATCH(json("PATCH", { version: 3, status: "contracted", contractPlace: "試験区の事務所", assigneeId: USER_ID }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 4 });
    expect(pm.deal.updateMany).toHaveBeenCalledWith({
      where: { id: DEAL_ID, version: 3 },
      data: { status: "contracted", contractPlace: "試験区の事務所", assigneeId: USER_ID, version: { increment: 1 } },
    });
    expect(recordChangesInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetTable: "deals", targetId: DEAL_ID, changedBy: "u-office",
      oldValues: expect.objectContaining({ status: "considering" }), newValues: expect.objectContaining({ status: "contracted" }),
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "deal_update", targetId: DEAL_ID, detail: { fields: ["assigneeId", "contractPlace", "status"] },
    }));
  });
  it("ほかの人が先に保存していたら 409・上書きしない", async () => {
    pm.deal.updateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(json("PATCH", { version: 2, name: "古い画面からの保存" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("無効な担当者・設定にない種別は 422", async () => {
    pm.user.findUnique.mockResolvedValue({ isActive: false });
    expect((await PATCH(json("PATCH", { version: 3, assigneeId: USER_ID }), ctx)).status).toBe(422);
    pm.user.findUnique.mockResolvedValue({ isActive: true });
    expect((await PATCH(json("PATCH", { version: 3, propertyKind: "castle" }), ctx)).status).toBe(422);
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("買取再販へ切り替えたら取引態様も空にする", async () => {
    await PATCH(json("PATCH", { version: 3, businessType: "resale" }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data).toMatchObject({ businessType: "resale", tradeSide: null });
  });
});

describe("POST /api/deals/[id]/refresh-property", () => {
  const propRow = {
    propertyType: "house", address: "東京都試験区2-2", lotNumber: null, buildingNumber: null, buildingName: null, roomNo: null,
    exclusiveArea: null, totalFloorArea: "98.5", landArea: "120", structureType: null, builtYear: null, builtMonth: null,
    access: null, layoutType: null, createdBy: "u-office", assignedTo: null,
  };
  it("物件の今の値で写しを上書きする", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue(propRow);
    const res = await REFRESH(json("POST", { version: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(pm.deal.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: DEAL_ID, version: 3 },
      data: { propertySnapshot: expect.objectContaining({ address: "東京都試験区2-2", floorArea: 98.5, landArea: 120 }) },
    });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_property_refresh" }));
  });
  it("手入力の物件の取引では 422", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: null });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(422);
  });
  it("見られない物件なら 404", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue({ ...propRow, createdBy: "other" });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(404);
  });
});
