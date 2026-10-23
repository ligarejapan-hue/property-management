import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn(async () => ({ id: "d" })) },
    dealParty: {
      count: vi.fn(async () => 0), create: vi.fn(), findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PARTY_ID, DEAL_PERMS } from "./route-mocks";
import { POST } from "../../../app/api/deals/[id]/parties/route";
import { PATCH, DELETE } from "../../../app/api/deals/[id]/parties/[partyId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  dealParty: { count: Fn; create: Fn; findFirst: Fn; updateMany: Fn; deleteMany: Fn };
};
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const pctx = { params: Promise.resolve({ id: DEAL_ID, partyId: PARTY_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue({ id: DEAL_ID });
  pm.dealParty.updateMany.mockResolvedValue({ count: 1 });
  pm.dealParty.deleteMany.mockResolvedValue({ count: 1 });
  pm.dealParty.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: PARTY_ID, version: 1, ...data }));
});

describe("当事者を足す", () => {
  it("同じ役割の最後に並べる・監査に氏名を出さない", async () => {
    pm.dealParty.count.mockResolvedValue(2);
    const res = await POST(json("POST", { role: "seller", partyType: "individual", name: "試験 花子", address: "東京都試験区3-3" }), ctx);
    expect(res.status).toBe(201);
    expect(pm.dealParty.count).toHaveBeenCalledWith({ where: { dealId: DEAL_ID, role: "seller" } });
    expect(pm.dealParty.create.mock.calls[0][0].data).toMatchObject({ dealId: DEAL_ID, role: "seller", name: "試験 花子", sortOrder: 2 });
    const audit = JSON.stringify((writeAuditLog as Fn).mock.calls[0][0]);
    expect(audit).not.toContain("試験 花子");
    expect(audit).not.toContain("試験区");
  });
  it("取引が無ければ 404・書く権限が無ければ 403", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await POST(json("POST", { role: "seller", partyType: "individual", name: "a" }), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.action !== "write"));
    expect((await POST(json("POST", { role: "seller", partyType: "individual", name: "a" }), ctx)).status).toBe(403);
  });
});

describe("当事者を直す・消す", () => {
  it("取引と当事者と版の番号がそろったときだけ書く", async () => {
    const res = await PATCH(json("PATCH", { version: 2, phone: "03-0000-0000" }), pctx);
    expect(await res.json()).toEqual({ version: 3 });
    expect(pm.dealParty.updateMany).toHaveBeenCalledWith({
      where: { id: PARTY_ID, dealId: DEAL_ID, version: 2 },
      data: { phone: "03-0000-0000", version: { increment: 1 } },
    });
  });
  it("版が古ければ 409・当事者が無ければ 404", async () => {
    pm.dealParty.updateMany.mockResolvedValue({ count: 0 });
    pm.dealParty.findFirst.mockResolvedValueOnce({ id: PARTY_ID });
    expect((await PATCH(json("PATCH", { version: 1, phone: "x" }), pctx)).status).toBe(409);
    pm.dealParty.findFirst.mockResolvedValueOnce(null);
    expect((await PATCH(json("PATCH", { version: 1, phone: "x" }), pctx)).status).toBe(404);
  });
  it("消すときも版の番号を見る", async () => {
    const res = await DELETE(new Request(`http://x/api?version=4`, { method: "DELETE" }), pctx);
    expect(res.status).toBe(200);
    expect(pm.dealParty.deleteMany).toHaveBeenCalledWith({ where: { id: PARTY_ID, dealId: DEAL_ID, version: 4 } });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_party_delete", targetId: DEAL_ID }));
  });
});
