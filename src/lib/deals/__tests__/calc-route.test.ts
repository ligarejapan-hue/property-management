import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn(async () => null) },
    dealRateTable: { findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS } from "./route-mocks";
import { GET } from "../../../app/api/deals/[id]/calc/route";
import { INITIAL_RATE_TABLES } from "../rate-tables";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { deal: { findUnique: Fn }; dealRateTable: { findMany: Fn } };
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue(null);
  pm.dealRateTable.findMany.mockResolvedValue(INITIAL_RATE_TABLES.map((t) => ({
    kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
  })));
});

describe("GET /api/deals/[id]/calc", () => {
  it("取引の計算結果を返す", async () => {
    pm.deal.findUnique.mockResolvedValue({
      id: DEAL_ID, dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
      assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "land", hasOc: false,
      contractAt: new Date("2026-05-01T01:00:00Z"), contractPlace: null, settlementAt: null, settlementPlace: null,
      price: BigInt(30_000_000), buildingTax: null, deposit: null, taxRateBp: 1000,
      propertySnapshot: {}, counterpartyBroker: {}, assessments: [], costs: {}, settlementTerms: {}, leases: [], overrides: {},
      version: 1, createdAt: new Date(), updatedAt: new Date(), parties: [],
    });
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calc.brokerage.excl).toBe(960_000);
    expect(body.calc.missing).toContain("決済日時");
  });
  it("無ければ 404・権限が無ければ 403", async () => {
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
  });
});
