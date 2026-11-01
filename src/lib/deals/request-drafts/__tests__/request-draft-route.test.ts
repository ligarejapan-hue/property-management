import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("next/server", async () => (await import("../../__tests__/route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("../../__tests__/route-mocks")).apiHelpersMock());
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmPublicPageConfig: vi.fn(async () => ({ trackingBaseUrl: "https://public.example" })) }));
vi.mock("@/lib/uploads-authorization", () => ({ canOpenReferralDocument: vi.fn(() => true) }));
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn() },
    dealScheduleItem: { findFirst: vi.fn() },
    dealSettings: { findUnique: vi.fn(async () => null) },
    dealRateTable: { findMany: vi.fn(async () => []) },
    companyProfile: { findUnique: vi.fn(async () => null) },
    property: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ name: "担当 太郎" })) },
    dealDocLink: { findFirst: vi.fn(async () => null) },
    auditLog: { findMany: vi.fn(async () => []) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS, PARTY_ID, USER_ID } from "../../__tests__/route-mocks";
import { GET, POST } from "@/app/api/deals/[id]/schedule/[itemId]/request-draft/route";
import { loadRequestDraftCopies, requestAccessOf } from "../store";
import { DEFAULT_REQUEST_TEMPLATES } from "../templates";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn }; dealScheduleItem: { findFirst: Fn }; dealDocLink: { findFirst: Fn }; property: { findUnique: Fn }; auditLog: { findMany: Fn }; dealSettings: { findUnique: Fn };
};
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const ctx = { params: Promise.resolve({ id: DEAL_ID, itemId: ITEM_ID }) };
const get = (qs = "") => GET(new Request(`http://x/api?${qs}`), ctx);
const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx);
const SECRET = "s".repeat(40);
const SELLER_LINK = { partyRole: "seller", party: { isSelf: false, role: "seller" } };
const ORIGINAL = process.env.DEAL_DOC_LINK_SECRET;
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.DEAL_DOC_LINK_SECRET;
  else process.env.DEAL_DOC_LINK_SECRET = ORIGINAL;
});

const seller = { id: PARTY_ID, role: "seller", partyType: "individual", name: "売主 太郎", representative: null, address: "東京都品川区1-1", phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 };
const dealRow = (o: Record<string, unknown> = {}) => ({
  id: DEAL_ID, dealNo: "2026-0001", name: "", businessType: "brokerage", tradeSide: "seller", status: "contracted", assigneeId: USER_ID, licensedAgentId: null, salesStaffId: null, opsStaffId: null,
  propertyId: null, propertyKind: null, hasOc: false, contractAt: null, contractPlace: null, settlementAt: new Date("2026-12-16T01:30:00Z"), settlementPlace: null,
  price: null, buildingTax: null, deposit: null, taxRateBp: 1000, propertySnapshot: { buildingName: "試験マンション", roomNo: "101", address: "東京都港区1-1" }, counterpartyBroker: {},
  version: 1, createdAt: new Date(), updatedAt: new Date(), assessments: {}, costs: {}, settlementTerms: {}, leases: [], overrides: {}, planInputs: {}, parties: [seller], ...o,
});
const OWNER_FULL = [
  { resource: "owner", action: "read", granted: true }, { resource: "owner_name", action: "full", granted: true }, { resource: "owner_address", action: "full", granted: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEAL_DOC_LINK_SECRET = SECRET;
  (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, ...OWNER_FULL]);
  pm.deal.findUnique.mockResolvedValue(dealRow());
  pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_seller_docs", assigneeId: USER_ID });
  pm.dealDocLink.findFirst.mockResolvedValue(null);
  pm.dealSettings.findUnique.mockResolvedValue(null);
});

describe("依頼文の権限の見方", () => {
  it("そのまま見られる人だけ差し込む(一部表示・マスクは空)", () => {
    expect(requestAccessOf([...DEAL_PERMS, ...OWNER_FULL])).toMatchObject({ name: true, address: true, canManage: true });
    const field = [...DEAL_PERMS, { resource: "owner", action: "read", granted: true }, { resource: "owner_name", action: "full", granted: true }, { resource: "owner_address", action: "partial", granted: true }];
    expect(requestAccessOf(field)).toMatchObject({ name: true, address: false });
    expect(requestAccessOf(DEAL_PERMS)).toMatchObject({ name: false, address: false });
  });
  it("所有者情報を読めない人は、表示レベルがあっても差し込まない", () => {
    expect(requestAccessOf([...DEAL_PERMS, { resource: "owner_name", action: "full", granted: true }])).toMatchObject({ name: false });
  });
  it("見るだけの人はリンクを扱えない", () => {
    expect(requestAccessOf(DEAL_PERMS.filter((p) => p.action === "read")).canManage).toBe(false);
  });
});

describe("差し込み済みの文面を作る", () => {
  it("取引の権限がなければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await get()).status).toBe(403);
  });
  it("別の取引の項目は 404", async () => {
    pm.dealScheduleItem.findFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(pm.dealScheduleItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ITEM_ID, dealId: DEAL_ID } }));
  });
  it("手入力の項目・結びつきの無い項目は 404", async () => {
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: null, assigneeId: null });
    expect((await get()).status).toBe(404);
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_final", assigneeId: null });
    expect((await get()).status).toBe(404);
  });
  it("結びついたひな形から作る。別の項目のひな形は選べない", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.templateId).toBe("r_seller");
    expect(d.text).toContain("売主 太郎 様");
    expect(d.text).toContain("試験マンション 101");
    expect((await get("templateId=r_bank")).status).toBe(422);
  });
  it("氏名の権限がなければ欄を空にし、選択肢にも本文にも名前を出さない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
    const res = await get();
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("売主 太郎");
    expect(raw).toContain('"field":"売主名"');
    expect(raw).toContain('"reason":"permission"');
  });
  it("提出用リンクがあれば差し込む", async () => {
    pm.dealDocLink.findFirst.mockResolvedValue({ publicId: "AAAAAAAAAAAAAAAAAAAAAA", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, ...SELLER_LINK });
    const d = await (await get()).json();
    expect(d.text).toContain("https://public.example/submit/");
    expect(pm.dealDocLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { dealId: DEAL_ID, partyId: PARTY_ID } }));
  });
  it("無効にした・期限切れのリンク、未発行は差し込まず知らせる", async () => {
    for (const link of [
      { publicId: "A", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(), ...SELLER_LINK },
      { publicId: "A", expiresAt: new Date(Date.now() - 86_400_000), revokedAt: null, ...SELLER_LINK },
      { publicId: "A", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, partyRole: "buyer", party: { isSelf: false, role: "seller" } },
      null,
    ]) {
      pm.dealDocLink.findFirst.mockResolvedValue(link);
      const d = await (await get()).json();
      expect(d.text).not.toContain("/submit/");
      expect(d.blanks).toContainEqual({ field: "提出用リンクのご案内", reason: "no_link" });
    }
  });
  it("中止・決済済の取引にはリンクを差し込まない(開いても提出できない)", async () => {
    pm.dealDocLink.findFirst.mockResolvedValue({ publicId: "AAAAAAAAAAAAAAAAAAAAAA", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, ...SELLER_LINK });
    for (const status of ["cancelled", "settled"]) {
      pm.deal.findUnique.mockResolvedValue(dealRow({ status }));
      const d = await (await get()).json();
      expect(d.text).not.toContain("/submit/");
      expect(d.blanks).toContainEqual({ field: "提出用リンクのご案内", reason: "no_link" });
    }
  });
  it("見るだけの人にはリンクを渡さない(読みにも行かない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS.filter((p) => p.action === "read"), ...OWNER_FULL]);
    pm.dealDocLink.findFirst.mockResolvedValue({ publicId: "A", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, ...SELLER_LINK });
    const d = await (await get()).json();
    expect(d.text).not.toContain("/submit/");
    expect(pm.dealDocLink.findFirst).not.toHaveBeenCalled();
  });
  it("宛先を選べる。ほかの取引の人は選べない", async () => {
    expect((await get(`recipientId=${PARTY_ID}`)).status).toBe(200);
    expect((await get("recipientId=other")).status).toBe(422);
  });
  it("物件を見られない人には棟の管理会社を出さない", async () => {
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_management_report", assigneeId: null });
    pm.deal.findUnique.mockResolvedValue(dealRow({ propertyId: "22222222-2222-4222-8222-222222222222" }));
    pm.property.findUnique.mockResolvedValue({ createdBy: "other", assignedTo: "other", building: { managementCompany: "棟の管理株式会社" } });
    (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "field_staff" });
    const raw = JSON.stringify(await (await get()).json());
    expect(raw).not.toContain("棟の管理株式会社");
  });
  it("応答を残さない", async () => {
    expect((await get()).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("コピーの記録", () => {
  it("誰が・どのひな形かの鍵だけを残す。文面は残さない", async () => {
    const res = await post({ templateId: "r_seller" });
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: USER_ID, action: "deal_request_draft_copy", targetTable: "deals", targetId: DEAL_ID,
      detail: { templateKey: "r_seller", itemKey: "s_seller_docs" },
    });
  });
  it("文面を送っても受け取らない", async () => {
    expect((await post({ templateId: "r_seller", text: "売主 太郎 様" })).status).toBe(422);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("結びついていないひな形は記録しない", async () => {
    expect((await post({ templateId: "r_bank" })).status).toBe(422);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("取引の権限がなければ記録しない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await post({ templateId: "r_seller" })).status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("コピーの履歴", () => {
  it("新しい順に、誰が・いつ・どのひな形かを返す。消したひな形でも行は残す", async () => {
    pm.auditLog.findMany.mockResolvedValue([
      { createdAt: new Date("2026-12-02T00:00:00Z"), detail: { templateKey: "r_seller" }, user: { name: "担当 太郎" } },
      { createdAt: new Date("2026-12-01T00:00:00Z"), detail: { templateKey: "gone" }, user: null },
    ]);
    const rows = await loadRequestDraftCopies(DEAL_ID, DEFAULT_REQUEST_TEMPLATES);
    expect(rows[0]).toEqual({ at: "2026-12-02T00:00:00.000Z", userName: "担当 太郎", templateLabel: DEFAULT_REQUEST_TEMPLATES.find((t) => t.id === "r_seller")!.label });
    expect(rows[1]).toEqual({ at: "2026-12-01T00:00:00.000Z", userName: null, templateLabel: "(消したひな形)" });
    expect(pm.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { action: "deal_request_draft_copy", targetTable: "deals", targetId: DEAL_ID } }));
  });
  it("読めなくても段取りを止めない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pm.auditLog.findMany.mockRejectedValue(new Error("db"));
    expect(await loadRequestDraftCopies(DEAL_ID, [])).toEqual([]);
    warn.mockRestore();
  });
});

describe("依頼文の migration", () => {
  const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261102200000_add_deal_request_templates/migration.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
  it("列を足すだけ", () => {
    expect(body).toContain(`ALTER TABLE "deal_settings" ADD COLUMN "request_templates" JSONB NOT NULL DEFAULT '[]';`);
    expect(body).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/);
  });
});
