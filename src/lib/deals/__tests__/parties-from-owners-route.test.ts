import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findUnique: vi.fn() },
    property: { findUnique: vi.fn() },
    propertyOwner: { findMany: vi.fn(async () => []) },
    dealParty: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 0 })) },
    companyProfile: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PROP_ID, DEAL_PERMS } from "./route-mocks";
import { POST } from "../../../app/api/deals/[id]/parties/from-owners/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  property: { findUnique: Fn };
  propertyOwner: { findMany: Fn };
  dealParty: { findMany: Fn; createMany: Fn };
  companyProfile: { findUnique: Fn };
  $queryRaw: Fn;
};
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const OWNER_PERMS = [
  ...DEAL_PERMS,
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
  { resource: "owner_phone", action: "full", granted: true },
];
const taro = { owner: { name: "試験 太郎", phone: "03-0", address: "東京都試験区1", currentAddress: "東京都新区2", corporateNumber: null, companyRegistryNumber: null } };
const post = () => POST(json("POST", {}), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS);
  pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
  pm.property.findUnique.mockResolvedValue({ createdBy: "u-office", assignedTo: null });
  pm.propertyOwner.findMany.mockResolvedValue([taro]);
  pm.dealParty.findMany.mockResolvedValue([]);
});

describe("物件の所有者を売主に入れる", () => {
  it("★足して人数を返す・取引の行をロックする・監査に氏名を出さない", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1 });
    expect(pm.$queryRaw).toHaveBeenCalled();
    expect(pm.dealParty.createMany.mock.calls[0][0].data[0]).toMatchObject({ dealId: DEAL_ID, role: "seller", name: "試験 太郎", address: "東京都新区2", phone: "03-0" });
    const audit = JSON.stringify((writeAuditLog as Fn).mock.calls[0][0]);
    expect(audit).not.toContain("試験");
    expect(audit).toContain("deal_party_from_owners");
  });

  it("★今の所有者だけ読む(終わった人・保管した人を入れない)", async () => {
    await post();
    expect(pm.propertyOwner.findMany.mock.calls[0][0].where).toEqual({ propertyId: PROP_ID, endDate: null, owner: { isArchived: false } });
  });

  it("★すでに売主にいれば足さない・並びは今の売主の後ろ", async () => {
    pm.dealParty.findMany.mockResolvedValue([{ name: "試験 太郎" }]);
    expect(await (await post()).json()).toEqual({ added: 0 });
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
    pm.dealParty.findMany.mockResolvedValue([{ name: "別の人" }]);
    await post();
    expect(pm.dealParty.createMany.mock.calls[0][0].data[0].sortOrder).toBe(1);
  });

  it("★所有者を読めない人は 403・何も入れない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
    expect((await post()).status).toBe(403);
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
  });

  it("★氏名が一部表示の人は 403・住所が一部表示の人は住所を入れない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => p.resource !== "owner_name"));
    expect((await post()).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => p.resource !== "owner_address"));
    expect((await post()).status).toBe(200);
    expect(pm.dealParty.createMany.mock.calls[0][0].data[0].address).toBeNull();
  });

  it("書く権限が無ければ 403・物件を読めなければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => !(p.resource === "deal" && p.action === "write")));
    expect((await post()).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => p.resource !== "property"));
    expect((await post()).status).toBe(403);
  });

  it("取引が無ければ 404・手入力の物件は 422・見られない物件は 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    pm.deal.findUnique.mockResolvedValue({ propertyId: null });
    expect((await post()).status).toBe(422);
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.property.findUnique.mockResolvedValue({ createdBy: "other", assignedTo: null });
    expect((await post()).status).toBe(404);
  });
});

describe("自社が売主の取引", () => {
  const OWNER_PERMS = [
    ...DEAL_PERMS,
    { resource: "owner", action: "read", granted: true },
    { resource: "owner_name", action: "full", granted: true },
  ];
  const ctx2 = { params: Promise.resolve({ id: DEAL_ID }) };
  const link = (name: string) => ({ owner: { name, phone: null, address: null, currentAddress: null, corporateNumber: null, companyRegistryNumber: null } });
  beforeEach(() => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS);
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: null });
    pm.companyProfile.findUnique.mockResolvedValue({ nameJa: "株式会社試験社" });
  });
  it("売主に自社がいれば、所有者を足さない", async () => {
    pm.dealParty.findMany.mockResolvedValue([{ name: "株式会社試験社", isSelf: true }]);
    (pm as never as { propertyOwner: { findMany: Fn } }).propertyOwner.findMany.mockResolvedValue([link("試験 花子")]);
    const res = await POST(new Request("http://x", { method: "POST" }), ctx2);
    expect(await res.json()).toEqual({ added: 0 });
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
  });
  it("自社の名前の所有者は足さない", async () => {
    pm.dealParty.findMany.mockResolvedValue([]);
    (pm as never as { propertyOwner: { findMany: Fn } }).propertyOwner.findMany.mockResolvedValue([link("株式会社 試験社"), link("試験 花子")]);
    await POST(new Request("http://x", { method: "POST" }), ctx2);
    expect(pm.dealParty.createMany.mock.calls[0][0].data.map((r: { name: string }) => r.name)).toEqual(["試験 花子"]);
  });
});
