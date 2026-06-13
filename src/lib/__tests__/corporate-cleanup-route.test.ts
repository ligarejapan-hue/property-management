import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    apiResponse: (data: unknown, status = 200) => Response.json(data, { status }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      return Response.json({ error: { message: "Server error", code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn(), OWNER_TRACKED_FIELDS: ["name", "address", "note", "corporateNumber"] }));
vi.mock("@/lib/prisma", () => ({ default: { owner: { findUnique: vi.fn(), updateMany: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import { GET, POST } from "../../app/api/owners/[id]/corporate-cleanup/route";

const pm = prisma as unknown as { owner: { findUnique: Mock; updateMany: Mock } };
const N = "1234567890123";

const PERMS_FULL = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "edit", granted: true },
  { resource: "owner_address", action: "edit", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
  { resource: "owner_corporate_number", action: "edit", granted: true },
];
const FULL_DISPLAY = { name: "full", nameKana: "full", phone: "full", zip: "full", address: "full", note: "full", email: "full", corporateNumber: "full" };

function ctx(id = "o1") { return { params: Promise.resolve({ id }) }; }
function getReq() { return new Request("http://localhost/api/owners/o1/corporate-cleanup") as any; }
function postReq(body: unknown) { return new Request("http://localhost/api/owners/o1/corporate-cleanup", { method: "POST", body: JSON.stringify(body) }) as any; }
function lastAudit(): any { return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0]; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({ id: "u1", email: "a@a", name: "A", role: "admin" } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as any);
  pm.owner.findUnique.mockResolvedValue({ id: "o1", name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: null, version: 2, isArchived: false });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/owners/[id]/corporate-cleanup (preview)", () => {
  it("検出ありで action=cleanup・changedFields・version を返す(DB無変更)", async () => {
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleanup.action).toBe("cleanup");
    expect(body.cleanup.importAction).toBe("save");
    expect(body.cleanup.changedFields).toContain("name");
    expect(body.cleanup.changedFields).toContain("corporateNumber");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_corporate_number=hidden は 403", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ ...FULL_DISPLAY, corporateNumber: "hidden" } as any);
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(403);
  });

  it("owner:read 欠如は 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL.filter((p) => !(p.resource === "owner" && p.action === "read")) as any);
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(403);
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
  });

  it("archived owner は 404", async () => {
    pm.owner.findUnique.mockResolvedValue({ id: "o1", name: "x", address: null, note: null, corporateNumber: null, version: 1, isArchived: true });
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(404);
  });

  it("raw-visible でない name は検出対象外(action=none)", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ ...FULL_DISPLAY, name: "masked" } as any);
    const res = await GET(getReq(), ctx());
    const body = await res.json();
    expect(body.cleanup.action).toBe("none");
  });

  it("AuditLog に PII を残さない", async () => {
    await GET(getReq(), ctx());
    const audit = lastAudit();
    expect(audit.action).toBe("owner_corporate_cleanup_preview");
    const s = JSON.stringify(audit.detail);
    expect(s).not.toContain(N);
    expect(s).not.toContain("株式会社○○");
  });
});

describe("POST /api/owners/[id]/corporate-cleanup (apply)", () => {
  it("name+corporateNumber を確定し version 楽観ロックで更新", async () => {
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } }), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.owner.version).toBe(3);
    const call = pm.owner.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "o1", version: 2 });
    expect(call.data.name).toBe("株式会社○○");
    expect(call.data.corporateNumber).toBe(N);
    expect(call.data.version).toEqual({ increment: 1 });
    expect(recordChanges).toHaveBeenCalled();
  });

  it("owner:write 欠如は 403(更新なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL.filter((p) => !(p.resource === "owner" && p.action === "write")) as any);
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_name field-level write 欠如で name 適用は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL.filter((p) => p.resource !== "owner_name") as any);
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("version 不一致は 409 CONFLICT", async () => {
    pm.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(postReq({ version: 1, apply: { name: true, address: false, note: false, corporateNumber: true } }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("manual(空化ガード)は 409 CLEANUP_NOT_AVAILABLE", async () => {
    pm.owner.findUnique.mockResolvedValue({ id: "o1", name: N, address: null, note: null, corporateNumber: null, version: 2, isArchived: false });
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CLEANUP_NOT_AVAILABLE");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("apply が changedFields に無いフィールドを指定したら 400", async () => {
    const res = await POST(postReq({ version: 2, apply: { name: false, address: true, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("APPLY_FIELD_MISMATCH");
  });

  it("apply 全 false は 400", async () => {
    const res = await POST(postReq({ version: 2, apply: { name: false, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(400);
  });

  it("AuditLog に PII を残さない", async () => {
    await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } }), ctx());
    const audit = lastAudit();
    expect(audit.action).toBe("owner_corporate_cleanup_apply");
    const s = JSON.stringify(audit.detail);
    expect(s).not.toContain(N);
    expect(s).not.toContain("株式会社○○");
  });
});

describe("idempotency / noop(cleanup済データへの再実行)", () => {
  const CLEAN = { id: "o1", name: "株式会社○○", address: null, note: null, corporateNumber: N, version: 4, isArchived: false };
  it("cleanup済 owner の再 preview は action none(更新導線なし)", async () => {
    pm.owner.findUnique.mockResolvedValue(CLEAN);
    const res = await GET(getReq(), ctx());
    const body = await res.json();
    expect(body.cleanup.action).toBe("none");
    expect(body.cleanup.changedFields).toEqual([]);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });
  it("cleanup済 owner への apply は 409 CLEANUP_NOT_AVAILABLE・updateMany/recordChanges 未実行(二重更新しない)", async () => {
    pm.owner.findUnique.mockResolvedValue(CLEAN);
    const res = await POST(postReq({ version: 4, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CLEANUP_NOT_AVAILABLE");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
    expect(recordChanges).not.toHaveBeenCalled();
  });
});
