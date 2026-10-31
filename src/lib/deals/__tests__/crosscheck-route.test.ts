import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn() }, property: { findUnique: vi.fn() },
    dealDocument: { findMany: vi.fn(async () => []) }, dealSettings: { findUnique: vi.fn(async () => null) },
  },
}));
const { loadCrosscheckRegistry } = vi.hoisted(() => ({ loadCrosscheckRegistry: vi.fn() }));
vi.mock("@/lib/deals/crosscheck-load", () => ({ loadCrosscheckRegistry }));
vi.mock("@/lib/deals/registry-rights-load", () => ({ loadDealRegistryRights: vi.fn() }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS, PROP_ID, USER_ID } from "./route-mocks";
import { SELLER_MISMATCH_MESSAGE } from "../crosscheck";
import { GET } from "../../../app/api/deals/[id]/crosscheck/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { deal: { findUnique: Fn }; property: { findUnique: Fn }; dealDocument: { findMany: Fn } };
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const REGISTRY_PERM = { resource: "registry_pdf", action: "preview", granted: true };
const OWNER_PERM = { resource: "owner", action: "read", granted: true };
const REG_NAME = "登記名義太郎";
const row = {
  id: DEAL_ID, dealNo: "2026-0007", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: PROP_ID, propertyKind: "unit", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: new Date("2026-11-30T01:00:00Z"), settlementPlace: null,
  price: BigInt(30_000_000), buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { floorArea: 65.5 }, counterpartyBroker: {}, assessments: [], costs: {}, settlementTerms: {},
  leases: [], overrides: {}, planInputs: {}, version: 3, createdAt: new Date(), updatedAt: new Date(),
  parties: [{ id: "x", role: "seller", partyType: "individual", name: "当事者花子", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 }],
};
const propertyRow = { createdBy: USER_ID, assignedTo: null, exclusiveArea: "65.50", exclusiveAreaRegistry: "60.25", landArea: null, landAreaMethod: null, totalFloorArea: null };
const registry = {
  status: "ok",
  areas: { unit: "60.25", land: null, building: null, attachmentCreatedAt: "2026-10-01T00:00:00.000Z" },
  rights: { activeRights: 1, readable: true, attachmentCreatedAt: "2026-10-01T00:00:00.000Z" },
  owners: { list: [{ name: REG_NAME, share: null }], confirmed: true, attachmentCreatedAt: "2026-10-01T00:00:00.000Z" },
};
const call = async () => {
  const res = await GET(new Request("http://x"), ctx);
  return { res, body: await res.json() };
};
const seller = (body: { crosscheck: { items: { key: string; status: string; message: string }[] } }) =>
  body.crosscheck.items.find((i) => i.key === "seller");

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, REGISTRY_PERM, OWNER_PERM]);
  pm.deal.findUnique.mockResolvedValue(row);
  pm.property.findUnique.mockResolvedValue(propertyRow);
  pm.dealDocument.findMany.mockResolvedValue([]);
  loadCrosscheckRegistry.mockResolvedValue(registry);
});

describe("GET /api/deals/[id]/crosscheck", () => {
  it("取引の権限が無ければ 403・取引が無ければ 404", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });
  it("全部の権限があれば売主名を比べるが、謄本の所有者名は返さない・保存しない", async () => {
    const { res, body } = await call();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(seller(body)?.status).toBe("mismatch");
    expect(seller(body)?.message).toBe(SELLER_MISMATCH_MESSAGE);
    expect(JSON.stringify(body)).not.toContain(REG_NAME);
    expect(loadCrosscheckRegistry).toHaveBeenCalledWith(PROP_ID, { kindBase: "unit", includeOwners: true });
  });
  it("所有者の閲覧が無い人: 氏名を読まず、比べない(件数に数えない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, REGISTRY_PERM]);
    loadCrosscheckRegistry.mockResolvedValue({ ...registry, owners: null });
    const { body } = await call();
    expect(loadCrosscheckRegistry).toHaveBeenCalledWith(PROP_ID, { kindBase: "unit", includeOwners: false });
    expect(seller(body)?.status).toBe("unverifiable");
    expect(seller(body)?.message).toContain("権限");
    expect(body.crosscheck.items.filter((i: { key: string; status: string }) => i.key === "seller" && i.status === "mismatch")).toEqual([]);
  });
  it("謄本を見る権限が無い人: 謄本を読まない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, OWNER_PERM]);
    const { body } = await call();
    expect(loadCrosscheckRegistry).not.toHaveBeenCalled();
    expect(seller(body)?.status).toBe("unverifiable");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("物件を見られない人(担当外): 物件の値も謄本も読まない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...propertyRow, createdBy: "77777777-7777-4777-8777-777777777777" });
    (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "field_staff" });
    const { body } = await call();
    expect(loadCrosscheckRegistry).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("60.25");
    expect(seller(body)?.status).toBe("unverifiable");
  });
  it("物件の無い取引: 権限の文言を出さず、片方が未入力", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, propertyId: null });
    const { body } = await call();
    expect(loadCrosscheckRegistry).not.toHaveBeenCalled();
    expect(seller(body)?.status).toBe("missing");
  });
  it("謄本の読み込みが壊れても画面は返す・例外の中身を出さない", async () => {
    loadCrosscheckRegistry.mockRejectedValue(new Error(`壊れた ${REG_NAME}`));
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(seller(body)?.status).toBe("unverifiable");
    expect(JSON.stringify(body)).not.toContain(REG_NAME);
  });
  it("監査には結果の種類と件数だけ(名前・金額を残さない)", async () => {
    await call();
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = writeAuditLog.mock.calls[0][0];
    expect(arg.action).toBe("deal_crosscheck_view");
    expect(Object.keys(arg.detail).sort()).toEqual(["compared", "mismatches", "summary"]);
    expect(JSON.stringify(arg)).not.toContain(REG_NAME);
    expect(JSON.stringify(arg)).not.toContain("当事者花子");
  });
  it("最新版の書類だけを比べる", async () => {
    pm.dealDocument.findMany.mockResolvedValue([
      { id: "new", docType: "funding_plan", variant: "purchase", version: 2, issuedAt: new Date(), inputSnapshot: {}, calcSnapshot: { price: 30_000_000 } },
      { id: "old", docType: "funding_plan", variant: "purchase", version: 1, issuedAt: new Date(), inputSnapshot: {}, calcSnapshot: { price: 1 } },
    ]);
    const { body } = await call();
    expect(body.crosscheck.items.find((i: { key: string }) => i.key === "price").status).toBe("match");
  });
});
