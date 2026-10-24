import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn(async () => null), updateMany: vi.fn() },
    dealRateTable: { findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    companyProfile: { findUnique: vi.fn(async () => ({ nameJa: "架空不動産株式会社" })) },
  },
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ read: vi.fn(async () => null) }) }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, DEAL_PERMS } from "./route-mocks";
import { POST } from "../../../app/api/deals/[id]/business-plan/preview/route";
import { INITIAL_RATE_TABLES } from "../rate-tables";
import { DEFAULT_BUSINESS_INPUTS } from "../business-schema";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { deal: { findUnique: Fn; updateMany: Fn }; dealRateTable: { findMany: Fn }; dealSettings: { findUnique: Fn } };
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const row = {
  id: DEAL_ID, dealNo: "2026-0009", name: "試験", businessType: "resale", tradeSide: null, status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: new Date("2026-05-01T01:00:00Z"), contractPlace: null, settlementAt: new Date("2026-06-01T01:00:00Z"), settlementPlace: null,
  price: BigInt(20_000_000), buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { buildingName: "試験マンション" }, counterpartyBroker: {}, assessments: {}, costs: {}, settlementTerms: {},
  leases: [], overrides: {}, planInputs: {}, version: 1, createdAt: new Date(), updatedAt: new Date(), parties: [],
};
const businessPlan = { ...DEFAULT_BUSINESS_INPUTS, salePrice: 28_000_000, saleDate: "2026-11-30", memo: "架空のメモ" };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u", role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue(row);
  pm.dealSettings.findUnique.mockResolvedValue(null);
  pm.dealRateTable.findMany.mockResolvedValue(INITIAL_RATE_TABLES.map((t) => ({
    kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
  })));
});

describe("POST /api/deals/[id]/business-plan/preview", () => {
  it("保存前の入力で計算し、出すセクションと HTML を返す(保存はしない・控えを残さない)", async () => {
    const res = await POST(json("POST", { businessPlan }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.calc.profit.revenue).toBe(28_000_000);
    expect(body.sections).toContain("profit");
    expect(body.sections).not.toContain("financing");
    expect(body.html).toContain("事業計画書(社内用)");
    expect(body.html).toContain("架空のメモ");
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("設定の種別×セクションの表を使う", async () => {
    pm.dealSettings.findUnique.mockResolvedValue({
      representativeTitle: null, representativeName: null, bankAccount: {}, propertyKinds: [], version: 1, updatedAt: new Date(),
      sectionMatrix: { unit: { holding: false } },
    });
    const body = await (await POST(json("POST", { businessPlan }), ctx)).json();
    expect(body.sections).not.toContain("holding");
  });
  it("仲介の取引では使えない(422)・形の違う入力は 422", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, businessType: "brokerage", tradeSide: "both" });
    const res = await POST(json("POST", { businessPlan }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NOT_RESALE");
    pm.deal.findUnique.mockResolvedValue(row);
    expect((await POST(json("POST", { businessPlan: { ...businessPlan, variant: "x" } }), ctx)).status).toBe(422);
    expect((await POST(json("POST", {}), ctx)).status).toBe(422);
  });
  it("取引が無ければ 404・権限が無ければ 403", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await POST(json("POST", { businessPlan }), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await POST(json("POST", { businessPlan }), ctx)).status).toBe(403);
  });
});
