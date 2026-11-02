import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null), create: vi.fn() },
    property: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
    changeLog: { create: vi.fn(async () => ({})) },
    dealParty: { count: vi.fn(async () => 0), createMany: vi.fn(async () => ({ count: 1 })) },
    propertyOwner: { findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    dealRateTable: { findMany: vi.fn(async () => []) },
    companyProfile: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PROP_ID, DEAL_PERMS } from "./route-mocks";
import { EMPTY_SNAPSHOT } from "../schemas";
import { GET as LIST, POST } from "../../../app/api/deals/route";
import { GET as OPTIONS } from "../../../app/api/deals/options/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findMany: Fn; count: Fn; findFirst: Fn; create: Fn };
  property: { findUnique: Fn; updateMany: Fn };
  dealParty: { count: Fn; createMany: Fn };
  propertyOwner: { findMany: Fn };
  changeLog: { create: Fn };
  $queryRaw: Fn;
  dealSettings: { findUnique: Fn };
  dealRateTable: { findMany: Fn };
  companyProfile: { findUnique: Fn };
};
const propRow = {
  propertyType: "apartment_unit", address: "東京都試験区試験町1-2-3", lotNumber: null, buildingNumber: null,
  buildingName: "試験マンション", roomNo: "201", exclusiveArea: "65.40", totalFloorArea: null, landArea: null,
  structureType: null, builtYear: 2001, builtMonth: 4, access: null, layoutType: null, createdBy: "someone", assignedTo: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T03:00:00Z"));
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.create.mockResolvedValue({ id: DEAL_ID, dealNo: "2026-0001" });
});

describe("GET /api/deals", () => {
  it("権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await LIST(new Request("http://x/api/deals"))).status).toBe(403);
  });
  it("絞り込み(状態・事業区分・自分の担当・物件名か住所か番号)", async () => {
    const res = await LIST(new Request("http://x/api/deals?status=contracted&businessType=resale&assignee=me&q=試験&page=2"));
    expect(res.status).toBe(200);
    expect(pm.deal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "contracted", businessType: "resale", assigneeId: "u-office",
        OR: [
          { name: { contains: "試験", mode: "insensitive" } },
          { dealNo: { contains: "試験" } },
          { propertySnapshot: { path: ["buildingName"], string_contains: "試験", mode: "insensitive" } },
          { propertySnapshot: { path: ["address"], string_contains: "試験", mode: "insensitive" } },
        ],
      },
      skip: 50, take: 50,
    }));
  });
  it("知らない状態は 422", async () => {
    expect((await LIST(new Request("http://x/api/deals?status=lease"))).status).toBe(422);
  });
});

describe("POST /api/deals", () => {
  it("手入力の物件で作る・番号は日本時間の年の最初・税率は表から", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([{ kind: "consumption_tax", validFrom: new Date("2019-10-01T00:00:00Z"), validTo: null, content: { rateBp: 1000 } }]);
    const res = await POST(json("POST", { businessType: "brokerage", tradeSide: "both", propertyKind: "land" }));
    expect(res.status).toBe(201);
    expect(pm.deal.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      dealNo: "2026-0001", name: "2026-0001", businessType: "brokerage", tradeSide: "both", propertyKind: "land",
      propertyId: null, taxRateBp: 1000, createdById: "u-office",
    }) }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_create", targetTable: "deals", targetId: DEAL_ID }));
    const detail = JSON.stringify((writeAuditLog as Fn).mock.calls[0][0].detail);
    expect(detail).not.toContain("試験の取引");
  });
  it("買取再販では取引態様を空にする", async () => {
    await POST(json("POST", { businessType: "resale", tradeSide: "seller" }));
    expect(pm.deal.create.mock.calls[0][0].data.tradeSide).toBeNull();
  });
  it("物件から作ると写しと種別をサーバーで入れる(送られた写しは使わない)", async () => {
    pm.property.findUnique.mockResolvedValue(propRow);
    await POST(json("POST", { businessType: "brokerage", propertyId: PROP_ID, propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "偽物" } }));
    const data = pm.deal.create.mock.calls[0][0].data;
    expect(data.propertyId).toBe(PROP_ID);
    expect(data.propertyKind).toBe("unit");
    expect(data.propertySnapshot).toMatchObject({ buildingName: "試験マンション", roomNo: "201", floorArea: 65.4 });
  });
  it("現地担当は担当外の物件から作れない(404・住所は返さない)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.property.findUnique.mockResolvedValue(propRow);
    const res = await POST(json("POST", { businessType: "brokerage", propertyId: PROP_ID }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("試験町");
    expect(pm.deal.create).not.toHaveBeenCalled();
  });
  it("物件を見る権限が無ければ物件から作れない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.resource !== "property"));
    expect((await POST(json("POST", { businessType: "brokerage", propertyId: PROP_ID }))).status).toBe(403);
  });
  it("設定にない種別は 422", async () => {
    expect((await POST(json("POST", { businessType: "brokerage", propertyKind: "castle" }))).status).toBe(422);
  });
  it("3回続けて番号がぶつかったら 409(もう一度押せばよい)(M5)", async () => {
    pm.deal.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await POST(json("POST", { businessType: "brokerage" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("DEAL_NO_BUSY");
  });
  it("番号がぶつかったら次の番号で作り直す", async () => {
    pm.deal.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ dealNo: "2026-0001" });
    pm.deal.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" })).mockResolvedValueOnce({ id: DEAL_ID, dealNo: "2026-0002" });
    const res = await POST(json("POST", { businessType: "brokerage" }));
    expect(res.status).toBe(201);
    expect(pm.deal.create.mock.calls.map((c) => c[0].data.dealNo)).toEqual(["2026-0001", "2026-0002"]);
  });
});

describe("GET /api/deals/options", () => {
  it("物件種別と、自社を入れるための会社情報(代表者は設定から)", async () => {
    pm.dealSettings.findUnique.mockResolvedValue({ representativeTitle: "代表取締役", representativeName: "試験 太郎", bankAccount: {}, propertyKinds: [], version: 1, updatedAt: new Date() });
    pm.companyProfile.findUnique.mockResolvedValue({ nameJa: "試験不動産株式会社", license: null, tel: "03-0000-0000", fax: null, email: null, hp: null, address: "東京都試験区1-1" });
    const body = await (await OPTIONS()).json();
    expect(body.propertyKinds.map((k: { key: string }) => k.key)).toEqual(["unit", "house", "land", "building"]);
    expect(body.selfParty).toEqual({ name: "試験不動産株式会社", representative: "代表取締役 試験 太郎", address: "東京都試験区1-1", phone: "03-0000-0000" });
  });
});

describe("POST /api/deals — 案件ステータスとの連動", () => {
  const post = () => POST(json("POST", { businessType: "brokerage", tradeSide: "seller", propertyId: PROP_ID }));
  const withCase = (caseStatus: string) => {
    (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, { resource: "property", action: "write", granted: true }]);
    pm.property.findUnique.mockReset();
    pm.property.findUnique.mockImplementation(async (a: { select: Record<string, unknown> }) =>
      "caseStatus" in a.select ? { caseStatus, createdBy: "u-office", assignedTo: null } : { ...propRow, caseStatus });
  };
  it("販売中の物件で作ると、取引は契約予定・案件も契約予定になる", async () => {
    withCase("on_sale");
    pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "considering" }]);
    const res = await post();
    expect(res.status).toBe(201);
    expect(pm.deal.create.mock.calls[0][0].data.status).toBe("considering");
    expect(pm.property.updateMany).toHaveBeenCalledWith({ where: { id: PROP_ID, caseStatus: "on_sale" }, data: { caseStatus: "contract_planned" } });
    expect(pm.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(pm.deal.create.mock.invocationCallOrder[0]);
  });
  it("決済完了の物件で作ると、取引は決済済で始まり案件は変えない", async () => {
    withCase("sold");
    pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "settled" }]);
    await post();
    expect(pm.deal.create.mock.calls[0][0].data.status).toBe("settled");
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });
  it("物件を編集できない人が作っても案件ステータスは動かさない", async () => {
    withCase("on_sale");
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
    pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "considering" }]);
    const res = await post();
    expect(res.status).toBe(201);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });
  it("手入力の物件の取引では物件を触らない", async () => {
    await POST(json("POST", { businessType: "brokerage", tradeSide: "seller" }));
    expect(pm.deal.create.mock.calls[0][0].data.status).toBe("considering");
    expect(pm.$queryRaw).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });
});

describe("物件から作るときの売主と管理費", () => {
  const OWNER_PERMS = [
    ...DEAL_PERMS,
    { resource: "owner", action: "read", granted: true },
    { resource: "owner_name", action: "full", granted: true },
    { resource: "owner_address", action: "partial", granted: true },
    { resource: "owner_phone", action: "full", granted: true },
  ];
  const owner = { isPrimary: true, owner: { name: "売主 太郎", address: "東京都", currentAddress: null, phone: "03-0000-0000", corporateNumber: null, companyRegistryNumber: null } };
  const body = { businessType: "brokerage", propertyId: PROP_ID };
  beforeEach(() => {
    pm.property.findUnique.mockResolvedValue({ ...propRow, caseStatus: "negotiating", managementFee: 12000, repairReserveFee: 8000 });
    pm.propertyOwner.findMany.mockResolvedValue([owner]);
  });

  it("所有者の氏名を見られる人なら売主に入れる。一部表示の住所は入れない。監査は件数だけ", async () => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS);
    expect((await POST(json("POST", body))).status).toBe(201);
    const row = pm.dealParty.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ dealId: DEAL_ID, role: "seller", name: "売主 太郎", address: null, phone: "03-0000-0000" });
    const audits = (writeAuditLog as Fn).mock.calls.map((c) => c[0]);
    expect(audits).toContainEqual(expect.objectContaining({ action: "deal_party_create", detail: { count: 1 } }));
    expect(JSON.stringify(audits)).not.toContain("売主 太郎");
  });
  it("所有者を見る権限がなければ、取引は作るが所有者を読まない", async () => {
    expect((await POST(json("POST", body))).status).toBe(201);
    expect(pm.propertyOwner.findMany).not.toHaveBeenCalled();
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
  });
  it("物件の管理費・修繕積立金を精算の条件に入れる", async () => {
    expect((await POST(json("POST", body))).status).toBe(201);
    expect(pm.deal.create.mock.calls[0][0].data.settlementTerms).toMatchObject({ managementFee: 12000, repairReserve: 8000 });
  });
  it("手入力の物件の取引には売主も管理費も入れない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS);
    expect((await POST(json("POST", { businessType: "brokerage" }))).status).toBe(201);
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
    expect(pm.deal.create.mock.calls[0][0].data).not.toHaveProperty("settlementTerms");
  });
});
