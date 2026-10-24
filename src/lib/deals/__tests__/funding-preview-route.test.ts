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
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ read: vi.fn(async (k: string) => (k === "deal-settings/logo-a.jpg" ? { body: Buffer.from("ab"), contentType: "x", size: 2 } : null)) }),
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, DEAL_PERMS } from "./route-mocks";
import { POST } from "../../../app/api/deals/[id]/funding-plan/preview/route";
import { INITIAL_RATE_TABLES } from "../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { deal: { findUnique: Fn; updateMany: Fn }; dealRateTable: { findMany: Fn } };
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const row = {
  id: DEAL_ID, dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: new Date("2026-05-01T01:00:00Z"), contractPlace: null, settlementAt: null, settlementPlace: null,
  price: BigInt(30_000_000), buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { buildingName: "試験マンション" }, counterpartyBroker: {}, assessments: {}, costs: {}, settlementTerms: {},
  leases: [], overrides: {}, planInputs: {}, version: 1, createdAt: new Date(), updatedAt: new Date(), parties: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u", role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue(row);
  pm.dealRateTable.findMany.mockResolvedValue(INITIAL_RATE_TABLES.map((t) => ({
    kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
  })));
});

describe("POST /api/deals/[id]/funding-plan/preview", () => {
  it("保存前の入力で計算し、HTML を返す(保存はしない・控えを残さない)", async () => {
    const fundingPlan = { ...DEFAULT_FUNDING_INPUTS, customerName: "架空 太郎", purchase: { ...DEFAULT_FUNDING_INPUTS.purchase, loanAmount: 40_000_000 } };
    const res = await POST(json("POST", { fundingPlan }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.calc.purchase.loans[0].monthly).toBe(112_914);
    expect(body.calc.purchase.lines.find((l: { key: string }) => l.key === "brokerage").amount).toBe(1_056_000);
    expect(body.html).toContain("架空 太郎");
    expect(body.html).toContain("架空不動産株式会社");
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("取引の設定のロゴと文面をプレビューにも入れる(PDF と同じ見た目)", async () => {
    (prismaMock as never as { dealSettings: { findUnique: Fn } }).dealSettings.findUnique.mockResolvedValue({
      representativeTitle: null, representativeName: null, bankAccount: {}, propertyKinds: [], version: 1, updatedAt: new Date(),
      logoKey: "deal-settings/logo-a.jpg", sealKey: null, texts: { funding_plan: { greeting: "ごあいさつ", notes: null } },
    });
    const body = await (await POST(json("POST", { fundingPlan: DEFAULT_FUNDING_INPUTS }), ctx)).json();
    expect(body.html).toContain('src="data:image/jpeg;base64,YWI="');
    expect(body.html).toContain("ごあいさつ");
    (prismaMock as never as { dealSettings: { findUnique: Fn } }).dealSettings.findUnique.mockResolvedValue(null);
  });
  it("形の違う入力は 422", async () => {
    expect((await POST(json("POST", { fundingPlan: { ...DEFAULT_FUNDING_INPUTS, mode: "x" } }), ctx)).status).toBe(422);
    expect((await POST(json("POST", {}), ctx)).status).toBe(422);
  });
  it("取引が無ければ 404・権限が無ければ 403", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await POST(json("POST", { fundingPlan: DEFAULT_FUNDING_INPUTS }), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await POST(json("POST", { fundingPlan: DEFAULT_FUNDING_INPUTS }), ctx)).status).toBe(403);
  });
});
