import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e && Array.isArray((e as Record<string, unknown>).issues)) {
        return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { companyProfile: { findUnique: vi.fn(), upsert: vi.fn() } } }));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { COMPANY_INFO } from "../sales-sheet/company-info";
import { GET, PUT } from "../../app/api/admin/company-settings/route";

const pm = prismaMock as never as {
  companyProfile: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
};
const admin = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
const nonAdmin = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: false }]);
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  pm.companyProfile.findUnique.mockResolvedValue(null);
  pm.companyProfile.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
    id: "singleton", nameJa: null, license: null, tel: null, fax: null, email: null, hp: null, address: null,
    updatedAt: new Date(), updatedById: "u1", ...args.update,
  }));
});

describe("GET /api/admin/company-settings", () => {
  it("admin で 200・未設定は既定(COMPANY_INFO)を返す・no-store", async () => {
    admin();
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.nameJa).toBe(COMPANY_INFO.nameJa); // 未設定→既定
    expect(json.data.tel).toBe(COMPANY_INFO.tel);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("DB値があれば実効値を返す(未設定項目は既定へフォールバック)", async () => {
    admin();
    pm.companyProfile.findUnique.mockResolvedValue({
      id: "singleton", nameJa: "株式会社テスト", license: null, tel: "01-2", fax: null,
      email: null, hp: null, address: null, updatedAt: new Date(), updatedById: "u1",
    });
    const json = await (await GET()).json();
    expect(json.data.nameJa).toBe("株式会社テスト");
    expect(json.data.tel).toBe("01-2");
    expect(json.data.license).toBe(COMPANY_INFO.license); // null→既定
  });
  it("非adminは403", async () => {
    nonAdmin();
    expect((await GET()).status).toBe(403);
  });
});

describe("PUT /api/admin/company-settings", () => {
  it("admin で保存・200", async () => {
    admin();
    const res = await PUT(putReq({ nameJa: "株式会社ABC", tel: "01-1" }));
    expect(res.status).toBe(200);
    const update = pm.companyProfile.upsert.mock.calls[0][0].update;
    expect(update.nameJa).toBe("株式会社ABC");
    expect(update.tel).toBe("01-1");
  });
  it("空文字はクリア(null=既定フォールバック)", async () => {
    admin();
    await PUT(putReq({ nameJa: "" }));
    expect(pm.companyProfile.upsert.mock.calls[0][0].update.nameJa).toBeNull();
  });
  it("未指定の項目は触らない(部分更新)", async () => {
    admin();
    await PUT(putReq({ nameJa: "X" }));
    const update = pm.companyProfile.upsert.mock.calls[0][0].update;
    expect(update.nameJa).toBe("X");
    expect("tel" in update).toBe(false);
    expect("address" in update).toBe(false);
  });
  it("非adminは403・保存しない", async () => {
    nonAdmin();
    const res = await PUT(putReq({ nameJa: "X" }));
    expect(res.status).toBe(403);
    expect(pm.companyProfile.upsert).not.toHaveBeenCalled();
  });
  it("監査に変更フィールド名を記録・値は残さない・targetIdは付けない", async () => {
    admin();
    await PUT(putReq({ nameJa: "株式会社ABC", tel: "01-1" }));
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.action).toBe("company_profile_update");
    expect(audit.detail.fields).toContain("nameJa");
    expect(audit.detail.fields).toContain("tel");
    expect(JSON.stringify(audit.detail)).not.toContain("株式会社ABC"); // 値は監査に残さない
    expect(audit.targetId).toBeUndefined();
    expect(audit.targetTable).toBe("company_profile");
    expect(audit.detail.target).toBe("singleton");
  });
});
