/**
 * 謄本の名義の確認の窓口(2026-11-08)。
 *
 * ⚠ここで守りたい事故:
 *  1. 氏名を伏せて見る人・謄本を見られない人に一覧を出す → 403
 *  2. 担当外の物件が一覧に出る → 物件一覧と同じ範囲で絞る
 *  3. 「謄本の名義に直す」を管理者以外が押せる → 403(中身に入る前に止める)
 *  4. 「このままでよい」を所有者を編集できない人が押せる → 403
 *  5. 全件を比べるを管理者以外が動かす → 403
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    registryOwnerCheck: { count: vi.fn(), findMany: vi.fn() },
    property: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/registry-owner-check/service", () => ({
  REGISTRY_OWNER_CHECK_RUN_MAX: 50,
  countPendingRegistryOwnerChecks: vi.fn(async () => 7),
  runRegistryOwnerChecks: vi.fn(async () => ({ processed: 1, counts: { same: 1 }, failed: 0, remaining: 0 })),
  keepRegistryOwners: vi.fn(async () => ({ dmRestored: true })),
  recordCheckAfterReplace: vi.fn(),
  restoreDmSendIfHold: vi.fn(),
}));
vi.mock("@/lib/registry-owner-apply/apply", () => ({
  replaceRegistryOwnersOnProperty: vi.fn(async () => ({ removed: 1, added: 1 })),
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { runRegistryOwnerChecks, keepRegistryOwners } from "@/lib/registry-owner-check/service";
import { replaceRegistryOwnersOnProperty } from "@/lib/registry-owner-apply/apply";
import { GET as listGET } from "@/app/api/registry-owner-checks/route";
import { POST as runPOST } from "@/app/api/registry-owner-checks/run/route";
import { POST as keepPOST } from "@/app/api/registry-owner-checks/[propertyId]/keep/route";
import { POST as replacePOST } from "@/app/api/registry-owner-checks/[propertyId]/replace/route";

const pm = prisma as unknown as {
  registryOwnerCheck: { count: Mock; findMany: Mock };
  property: { findUnique: Mock };
};
const g = (resource: string, action: string) => ({ resource, action, granted: true });
const VIEW = [g("property", "read"), g("owner", "read"), g("owner_name", "full"), g("registry_pdf", "preview")];
const KEEP = [...VIEW, g("owner", "write")];
const ADMIN = [...KEEP, g("user_management", "read"), g("property", "write"), g("import", "write")];
const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ propertyId: PID }) };
const post = (body: unknown) =>
  new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "office_staff" });
  pm.registryOwnerCheck.count.mockResolvedValue(0);
  pm.registryOwnerCheck.findMany.mockResolvedValue([]);
  pm.property.findUnique.mockResolvedValue({ id: PID, assignedTo: null, createdBy: "u1" });
});

describe("一覧", () => {
  it("氏名が伏せ字の人には出さない(403)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(VIEW.map((p) => (p.resource === "owner_name" ? g("owner_name", "masked") : p)));
    const res = await listGET(new Request("http://x/api/registry-owner-checks"));
    expect(res.status).toBe(403);
    expect(pm.registryOwnerCheck.findMany).not.toHaveBeenCalled();
  });

  it("違う・未判断・比べ直し不要・アーカイブ以外だけ。現地担当は自分の物件だけ", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "u9", role: "field_staff" });
    (getUserPermissions as Mock).mockResolvedValue(VIEW);
    const res = await listGET(new Request("http://x/api/registry-owner-checks"));
    expect(res.status).toBe(200);
    const where = pm.registryOwnerCheck.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ result: "mismatch", decision: null, stale: false, property: { isArchived: false } });
    expect(JSON.stringify(where.property.AND)).toContain("u9");
    const body = await res.json();
    // 管理者でなければ「まだ比べていない件数」は出さない
    expect(body.canRun).toBe(false);
    expect(body.pending).toBeNull();
    expect(body.canReplace).toBe(false);
  });

  it("管理者には件数と操作の可否を返す", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN);
    const body = await (await listGET(new Request("http://x/api/registry-owner-checks"))).json();
    expect(body).toMatchObject({ canRun: true, pending: 7, canKeep: true, canReplace: true });
  });
});

describe("操作の権限", () => {
  it("全件を比べるは管理者だけ", async () => {
    (getUserPermissions as Mock).mockResolvedValue(KEEP);
    expect((await runPOST(post({ limit: 10 }))).status).toBe(403);
    expect(runRegistryOwnerChecks).not.toHaveBeenCalled();
    (getUserPermissions as Mock).mockResolvedValue(ADMIN);
    expect((await runPOST(post({ limit: 10 }))).status).toBe(200);
  });

  it("このままでよいは所有者を編集できる人まで", async () => {
    (getUserPermissions as Mock).mockResolvedValue(VIEW);
    expect((await keepPOST(post({ attachmentId: AID, restoreDm: true }) as never, params)).status).toBe(403);
    expect(keepRegistryOwners).not.toHaveBeenCalled();
    (getUserPermissions as Mock).mockResolvedValue([...KEEP, g("property", "write")]);
    const res = await keepPOST(post({ attachmentId: AID, restoreDm: true }) as never, params);
    expect(res.status).toBe(200);
    expect(keepRegistryOwners).toHaveBeenCalledWith(expect.objectContaining({ propertyId: PID, expectedAttachmentId: AID, restoreDm: true }));
  });

  it("DM を戻すのは物件を編集できる人だけ(戻さないだけなら通る)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(KEEP);
    expect((await keepPOST(post({ attachmentId: AID, restoreDm: true }) as never, params)).status).toBe(403);
    expect(keepRegistryOwners).not.toHaveBeenCalled();
    expect((await keepPOST(post({ attachmentId: AID, restoreDm: false }) as never, params)).status).toBe(200);
    (getUserPermissions as Mock).mockResolvedValue([...KEEP, g("property", "write")]);
    expect((await keepPOST(post({ attachmentId: AID, restoreDm: true }) as never, params)).status).toBe(200);
  });

  it("このままでよいも担当外の物件は 403", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "u9", role: "field_staff" });
    (getUserPermissions as Mock).mockResolvedValue(KEEP);
    pm.property.findUnique.mockResolvedValue({ id: PID, assignedTo: "other", createdBy: "other" });
    expect((await keepPOST(post({ attachmentId: AID, restoreDm: false }) as never, params)).status).toBe(403);
    expect(keepRegistryOwners).not.toHaveBeenCalled();
  });

  it("謄本の名義に直すは管理者だけ", async () => {
    const body = { attachmentId: AID, linkedOwnerIds: [AID], removeOwnerIds: [AID], restoreDm: false };
    (getUserPermissions as Mock).mockResolvedValue(KEEP);
    expect((await replacePOST(post(body) as never, params)).status).toBe(403);
    expect(replaceRegistryOwnersOnProperty).not.toHaveBeenCalled();
    (getUserPermissions as Mock).mockResolvedValue(ADMIN);
    expect((await replacePOST(post(body) as never, params)).status).toBe(200);
    expect(replaceRegistryOwnersOnProperty).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAttachmentId: AID, expectedLinkedOwnerIds: [AID], expectedRemoveOwnerIds: [AID] }),
    );
  });
});
