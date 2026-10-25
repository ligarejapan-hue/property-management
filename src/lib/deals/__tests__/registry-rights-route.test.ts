import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({ default: { deal: { findUnique: vi.fn() }, property: { findUnique: vi.fn() } } }));
const { loadDealRegistryRights } = vi.hoisted(() => ({ loadDealRegistryRights: vi.fn() }));
vi.mock("@/lib/deals/registry-rights-load", () => ({ loadDealRegistryRights }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS, PROP_ID, USER_ID } from "./route-mocks";
import { GET } from "../../../app/api/deals/[id]/registry-rights/route";

type Fn = ReturnType<typeof vi.fn>;
const findUnique = (prismaMock as never as { deal: { findUnique: Fn } }).deal.findUnique;
const propFind = (prismaMock as never as { property: { findUnique: Fn } }).property.findUnique;
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const SUMMARY = {
  hasKouku: true, currentOwners: [{ name: "架空 一郎", address: "架空県架空市", share: null }],
  activeRights: [{ rank: "1", purpose: "抵当権設定", amount: "金1,000万円", holder: "架空銀行", debtor: "架空 一郎", activeAnnotations: 0 }],
  cautions: [{ section: "甲区", rank: "4", purpose: "差押" }], notes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, { resource: "registry_pdf", action: "preview", granted: true }]);
  findUnique.mockResolvedValue({ id: DEAL_ID, propertyId: PROP_ID });
  propFind.mockResolvedValue({ createdBy: USER_ID, assignedTo: null });
  loadDealRegistryRights.mockImplementation(async (p: string | null) => (p ? { status: "ok", attachmentCreatedAt: "2026-10-01T00:00:00.000Z", summary: SUMMARY } : { status: "none" }));
});

describe("取引の謄本の登記の現況の口(段5c-2)", () => {
  it("物件を見られない人(物件の閲覧が無い・担当外)には謄本を読まずに none", async () => {
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.resource !== "property"));
    expect((await (await GET(new Request("http://x"), ctx)).json()).rights).toEqual({ status: "none" });
    expect(loadDealRegistryRights).toHaveBeenCalledWith(null);
    (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, { resource: "registry_pdf", action: "preview", granted: true }]);
    propFind.mockResolvedValue({ createdBy: "77777777-7777-4777-8777-777777777777", assignedTo: null });
    loadDealRegistryRights.mockClear();
    await GET(new Request("http://x"), ctx);
    expect(loadDealRegistryRights).toHaveBeenCalledWith(null);
    // 謄本を見る権限(registry_pdf:preview)が無い人にも読まない(既存の謄本の画面と同じ)
    propFind.mockResolvedValue({ createdBy: USER_ID, assignedTo: null });
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.resource !== "registry_pdf"));
    loadDealRegistryRights.mockClear();
    await GET(new Request("http://x"), ctx);
    expect(loadDealRegistryRights).toHaveBeenCalledWith(null);
  });

  it("取引の閲覧で読める・所有者の閲覧が無ければ権利者名を出さない・監査は件数だけ", async () => {
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rights.activeRights).toEqual([{ rank: "1", purpose: "抵当権設定", amount: "金1,000万円", holder: null }]);
    expect(body.rights.cautions).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("架空");
    expect(loadDealRegistryRights).toHaveBeenCalledWith(PROP_ID);
    const a = writeAuditLog.mock.calls[0][0];
    expect(a).toMatchObject({ action: "deal_registry_rights_view", targetTable: "deals", targetId: DEAL_ID, detail: { status: "ok", activeRights: 1, cautions: 1 } });
    expect(JSON.stringify(a)).not.toContain("架空");
  });

  it("所有者の閲覧もあれば権利者名を出す", async () => {
    (getUserPermissions as Fn).mockResolvedValue([...DEAL_PERMS, { resource: "registry_pdf", action: "preview", granted: true }, { resource: "owner", action: "read", granted: true }]);
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.rights.activeRights[0].holder).toBe("架空銀行");
    expect(JSON.stringify(body)).not.toContain("架空 一郎");
  });

  it("取引の閲覧が無ければ 403・取引が無ければ 404・物件が無い取引は none で監査しない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
    findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
    findUnique.mockResolvedValue({ id: DEAL_ID, propertyId: null });
    loadDealRegistryRights.mockResolvedValue({ status: "none" });
    expect((await (await GET(new Request("http://x"), ctx)).json()).rights).toEqual({ status: "none" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
