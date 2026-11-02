import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findUnique: vi.fn() },
    property: { findUnique: vi.fn() },
    dealParty: { count: vi.fn(async () => 0), createMany: vi.fn(async () => ({ count: 1 })) },
    propertyOwner: { findMany: vi.fn(async () => []) },
    companyProfile: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS, PROP_ID } from "./route-mocks";
import { POST } from "../../../app/api/deals/[id]/parties/from-owners/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  property: { findUnique: Fn };
  dealParty: { count: Fn; createMany: Fn };
  propertyOwner: { findMany: Fn };
  $queryRaw: Fn;
};
const OWNER_PERMS = [
  ...DEAL_PERMS,
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
  { resource: "owner_phone", action: "full", granted: true },
];
const owner = (name: string) => ({
  isPrimary: false,
  owner: { name, address: "東京都試験区", currentAddress: null, phone: null, corporateNumber: null, companyRegistryNumber: null },
});
const req = () => new Request("http://x", { method: "POST" });
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS);
  pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
  pm.property.findUnique.mockResolvedValue({ createdBy: "someone", assignedTo: null });
  pm.dealParty.count.mockResolvedValue(0);
  pm.propertyOwner.findMany.mockResolvedValue([owner("試験 甲"), owner("試験 乙")]);
});

describe("物件の所有者を売主に入れる", () => {
  it("取引の行を握ってから、所有者を売主に足す。監査は件数だけ", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
    expect(pm.$queryRaw).toHaveBeenCalled();
    expect(pm.dealParty.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_party_create", detail: { count: 2 } }));
    expect(JSON.stringify((writeAuditLog as Fn).mock.calls)).not.toContain("試験");
  });
  it("売主がすでにいれば 409・何も足さない", async () => {
    pm.dealParty.count.mockResolvedValue(1);
    expect((await POST(req(), ctx)).status).toBe(409);
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
  });
  it("氏名をそのまま見られない人は 403(所有者を読まない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([
      ...DEAL_PERMS, { resource: "owner", action: "read", granted: true }, { resource: "owner_name", action: "partial", granted: true },
    ]);
    expect((await POST(req(), ctx)).status).toBe(403);
    expect(pm.propertyOwner.findMany).not.toHaveBeenCalled();
  });
  it("取引を書けない人は 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => !(p.resource === "deal" && p.action === "write")));
    expect((await POST(req(), ctx)).status).toBe(403);
  });
  it("担当外の物件は無いのと同じ返事(所有者を読まない)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    expect((await POST(req(), ctx)).status).toBe(404);
    expect(pm.propertyOwner.findMany).not.toHaveBeenCalled();
  });
  it("手入力の物件の取引は 422・所有者がいなければ 422", async () => {
    pm.deal.findUnique.mockResolvedValueOnce({ propertyId: null });
    expect((await POST(req(), ctx)).status).toBe(422);
    pm.propertyOwner.findMany.mockResolvedValue([]);
    expect((await POST(req(), ctx)).status).toBe(422);
  });
});
