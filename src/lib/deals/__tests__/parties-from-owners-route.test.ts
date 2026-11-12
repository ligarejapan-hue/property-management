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
import { GET, POST } from "../../../app/api/deals/[id]/parties/from-owners/route";

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
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const taro = { owner: { id: OWNER_A, name: "試験 太郎", phone: "03-0", address: "東京都試験区1", currentAddress: "東京都新区2", corporateNumber: null, companyRegistryNumber: null }, registryEntries: [] };
const post = (body: Record<string, unknown> = {}) => POST(json("POST", body), ctx);
const hanako = { owner: { ...taro.owner, id: OWNER_B, name: "試験 花子" }, registryEntries: [] };

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
    expect(await (await post({ ownerIds: [OWNER_A] })).json()).toEqual({ added: 0 });
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
    pm.dealParty.findMany.mockResolvedValue([{ name: "別の人" }]);
    await post({ ownerIds: [OWNER_A] });
    expect(pm.dealParty.createMany.mock.calls[0][0].data[0].sortOrder).toBe(1);
  });

  it("★売主がすでにいる取引は、選ばなければ足さない(相続人が売主の取引に亡くなった名義人を足さない)", async () => {
    pm.dealParty.findMany.mockResolvedValue([{ name: "相続 一郎" }]);
    expect(await (await post()).json()).toEqual({ added: 0 });
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
  });

  it("★選んだ人だけ足す・今の所有者でない ID は足さない", async () => {
    pm.propertyOwner.findMany.mockResolvedValue([taro, hanako]);
    pm.dealParty.findMany.mockResolvedValue([{ name: "相続 一郎" }]);
    await post({ ownerIds: [OWNER_B, "33333333-3333-4333-8333-333333333333"] });
    expect(pm.dealParty.createMany.mock.calls[0][0].data.map((r: { name: string }) => r.name)).toEqual(["試験 花子"]);
  });

  it("★売主がいない取引は、選ばなくても全員足す", async () => {
    pm.propertyOwner.findMany.mockResolvedValue([taro, hanako]);
    expect(await (await post()).json()).toEqual({ added: 2 });
  });

  it("★持分は登記上の記載(所有者事項の行)の合計を入れる・読めない行があれば空(2026-11-12)", async () => {
    pm.propertyOwner.findMany.mockResolvedValue([
      // 同じ人が住所違い・持分ごとに3行: 2/10+3/10+2/10 → 7/10(約分しない)
      { ...taro, registryEntries: [{ shareNum: 2, shareDen: 10 }, { shareNum: 3, shareDen: 10 }, { shareNum: 2, shareDen: 10 }] },
      // 持分が読めない行が混じる人は、合計を入れない
      { ...hanako, registryEntries: [{ shareNum: 3, shareDen: 10 }, { shareNum: null, shareDen: null }] },
    ]);
    await post();
    const rows = pm.dealParty.createMany.mock.calls[0][0].data as Array<{ name: string; shareNum: number | null; shareDen: number | null }>;
    expect(rows.map((r) => [r.name, r.shareNum, r.shareDen])).toEqual([
      ["試験 太郎", 7, 10],
      ["試験 花子", null, null],
    ]);
    // 登記上の記載も一緒に読む(持分だけ・住所は読まない)
    expect(pm.propertyOwner.findMany.mock.calls[0][0].select.registryEntries).toEqual({
      select: { shareNum: true, shareDen: true },
    });
  });

  it("⚠候補から選んで足すときも、同じ名前の2人の持分を足す(選ばれた1人目の分だけにしない・@codex #717 P2)", async () => {
    // 同じ方が二重に登録されている: 1人目 2/10・2人目 5/10。候補に出る ID は1人目だけ。
    const OWNER_A2 = "44444444-4444-4444-8444-444444444444";
    pm.propertyOwner.findMany.mockResolvedValue([
      { ...taro, registryEntries: [{ shareNum: 2, shareDen: 10 }] },
      { owner: { ...taro.owner, id: OWNER_A2, name: "試験　太郎" }, registryEntries: [{ shareNum: 5, shareDen: 10 }] },
    ]);
    pm.dealParty.findMany.mockResolvedValue([{ name: "相続 一郎" }]);
    await post({ ownerIds: [OWNER_A] });
    const rows = pm.dealParty.createMany.mock.calls[0][0].data as Array<{ name: string; shareNum: number | null; shareDen: number | null }>;
    expect(rows.map((r) => [r.name, r.shareNum, r.shareDen])).toEqual([["試験 太郎", 7, 10]]);
  });

  it("★(株)と株式会社・異体字の同じ人を二重に足さない", async () => {
    const corp = { owner: { ...taro.owner, id: OWNER_B, name: "(株)試験髙橋" }, registryEntries: [] };
    pm.propertyOwner.findMany.mockResolvedValue([corp]);
    pm.dealParty.findMany.mockResolvedValue([{ name: "株式会社 試験高橋" }]);
    expect(await (await post({ ownerIds: [OWNER_B] })).json()).toEqual({ added: 0 });
  });

  it("選ぶ ID が UUID でない・空なら 422", async () => {
    expect((await post({ ownerIds: ["x"] })).status).toBe(422);
    expect((await post({ ownerIds: [] })).status).toBe(422);
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
  const link = (name: string) => ({ owner: { name, phone: null, address: null, currentAddress: null, corporateNumber: null, companyRegistryNumber: null }, registryEntries: [] });
  beforeEach(() => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS);
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: null });
    pm.companyProfile.findUnique.mockResolvedValue({ nameJa: "株式会社試験社" });
  });
  it("売主に自社がいれば、所有者を足さない", async () => {
    pm.dealParty.findMany.mockResolvedValue([{ name: "株式会社試験社", isSelf: true }]);
    (pm as never as { propertyOwner: { findMany: Fn } }).propertyOwner.findMany.mockResolvedValue([link("試験 花子")]);
    const res = await POST(json("POST", {}), ctx2);
    expect(await res.json()).toEqual({ added: 0 });
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
  });
  it("自社の名前の所有者は足さない", async () => {
    pm.dealParty.findMany.mockResolvedValue([]);
    (pm as never as { propertyOwner: { findMany: Fn } }).propertyOwner.findMany.mockResolvedValue([link("株式会社 試験社"), link("試験 花子")]);
    await POST(json("POST", {}), ctx2);
    expect(pm.dealParty.createMany.mock.calls[0][0].data.map((r: { name: string }) => r.name)).toEqual(["試験 花子"]);
  });
});

describe("売主にいない所有者の候補", () => {
  const get = () => GET(new Request("http://x"), ctx);
  beforeEach(() => {
    pm.propertyOwner.findMany.mockResolvedValue([taro, hanako]);
    pm.dealParty.findMany.mockResolvedValue([{ name: "試験　太郎", isSelf: false }]);
    pm.companyProfile.findUnique.mockResolvedValue(null);
  });

  it("★売主にいない人だけ、ID と氏名だけ返す(住所・電話は返さない)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasSellers: true, candidates: [{ ownerId: OWNER_B, name: "試験 花子" }] });
  });
  it("★売主がいない取引は候補を出さない(全員を足すボタンの方)", async () => {
    pm.dealParty.findMany.mockResolvedValue([]);
    expect(await (await get()).json()).toEqual({ hasSellers: false, candidates: [] });
  });
  it("★自社が売主の取引は候補を出さない・自社の名前の人も出さない", async () => {
    pm.dealParty.findMany.mockResolvedValue([{ name: "株式会社試験社", isSelf: true }]);
    expect((await (await get()).json()).candidates).toEqual([]);
    pm.dealParty.findMany.mockResolvedValue([{ name: "試験 太郎", isSelf: false }]);
    pm.companyProfile.findUnique.mockResolvedValue({ nameJa: "試験 花子" });
    expect((await (await get()).json()).candidates).toEqual([]);
  });
  it("★氏名をそのまま見られない人・編集できない人・物件を見られない人には返さない(人数も)", async () => {
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => p.resource !== "owner_name"));
    expect((await get()).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => !(p.resource === "deal" && p.action === "write")));
    expect((await get()).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(OWNER_PERMS.filter((p) => p.resource !== "property"));
    expect((await get()).status).toBe(403);
  });
  it("★読むだけ(足さない・ロックしない)", async () => {
    await get();
    expect(pm.dealParty.createMany).not.toHaveBeenCalled();
    expect(pm.$queryRaw).not.toHaveBeenCalled();
  });
});
