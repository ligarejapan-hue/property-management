import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { attachment: { findMany: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET } from "../route";
import { registryDisplayName } from "@/lib/attachments/registry-display-name";

const pm = prisma as unknown as { attachment: { findMany: Mock } };
const UUID = "11111111-1111-4111-8111-111111111111";
const BASE_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
const ALL_VISIBLE = { name: "full", nameKana: "full", phone: "full", zip: "full", address: "full", note: "full", email: "full", corporateNumber: "full" };
const req = () => new Request("http://localhost/api/attachments/trash");

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "admin-1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue(BASE_PERMS);
  (getOwnerDisplayConfig as unknown as Mock).mockResolvedValue({ ...ALL_VISIBLE });
  pm.attachment.findMany.mockResolvedValue([]);
});

describe("GET /api/attachments/trash", () => {
  it("user_management:read が無ければ 403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValueOnce(BASE_PERMS.filter((p) => p.resource !== "user_management"));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("owner PII の一部が masked なら 403", async () => {
    (getOwnerDisplayConfig as unknown as Mock).mockResolvedValueOnce({ ...ALL_VISIBLE, phone: "masked" });
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("where.isDeleted=true・select に deletedAt・fileUrl 非返却", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([
      { id: "a1", fileName: "謄本秘密.pdf", type: "registry", createdAt: new Date(), deletedAt: new Date(), targetType: "property", targetId: UUID },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const call = pm.attachment.findMany.mock.calls[0][0];
    expect(call.where.isDeleted).toBe(true);
    expect(call.select.deletedAt).toBe(true);
    expect(call.select).not.toHaveProperty("fileUrl");
    const body = await res.json();
    expect(body.data[0]).not.toHaveProperty("fileUrl");
  });

  it("registry の fileName は共通の決まりごとで組み立てる（PII を出さない）", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([
      { id: "a1", fileName: "山田太郎_謄本.pdf", type: "registry", registryCertificateType: "owner", createdAt: new Date("2026-08-25T03:00:00.000Z"), deletedAt: new Date(), targetType: "property", targetId: UUID },
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.data[0].fileName).toBe(
      registryDisplayName("owner", new Date("2026-08-25T03:00:00.000Z")),
    );
    expect(body.data[0].fileName).toBe("謄本(所有者事項)_2026-08-25.pdf");
    expect(JSON.stringify(body)).not.toContain("山田太郎");
  });

  it("種別が記録されていない（手作業で取り込んだ）謄本も生の名前は返さない", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([
      { id: "a1", fileName: "世田谷区弦巻１丁目３２－３１不動産登記.pdf", type: "registry", registryCertificateType: null, createdAt: new Date("2026-08-25T03:00:00.000Z"), deletedAt: new Date(), targetType: "property", targetId: UUID },
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.data[0].fileName).toBe("謄本_2026-08-25.pdf");
    expect(JSON.stringify(body)).not.toContain("弦巻");
  });

  it("組み立ての材料（種別）を、そのまま外へ返さない", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([
      { id: "a1", fileName: "謄本.pdf", type: "registry", registryCertificateType: "all", createdAt: new Date(), deletedAt: new Date(), targetType: "property", targetId: UUID },
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.data[0]).not.toHaveProperty("registryCertificateType");
  });
});
