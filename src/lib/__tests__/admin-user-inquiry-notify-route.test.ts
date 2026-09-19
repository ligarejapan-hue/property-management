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
vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ checkSaleDmAccessFor: vi.fn() }));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";
import { GET, PUT } from "../../app/api/admin/users/[id]/inquiry-notify/route";

const pm = prismaMock as never as {
  user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};

const read = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "read", granted: true }]);
const write = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
const forbidden = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

const params = (id = "u-target") => ({ params: Promise.resolve({ id }) });
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "u-target",
  email: "target@example.com",
  inquiryNotifyEnabled: false,
  inquiryNotifyEmail: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "admin-1", email: "admin@example.com" });
  pm.user.findUnique.mockResolvedValue(row());
  pm.user.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...row(), ...args.data }));
  (checkSaleDmAccessFor as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, permissions: [], ownerDisplayConfig: {} });
});

describe("GET /api/admin/users/:id/inquiry-notify", () => {
  it("user_management:read が無ければ403", async () => {
    forbidden();
    const res = await GET(new Request("http://x") as never, params());
    expect(res.status).toBe(403);
  });

  it("対象ユーザーが無ければ404", async () => {
    read();
    pm.user.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://x") as never, params());
    expect(res.status).toBe(404);
  });

  it("200・現在値 + ログインemail + canUseSaleDm を返す", async () => {
    read();
    pm.user.findUnique.mockResolvedValue(row({ inquiryNotifyEnabled: true, inquiryNotifyEmail: "notify@example.com" }));
    const res = await GET(new Request("http://x") as never, params());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({
      enabled: true,
      email: "notify@example.com",
      loginEmail: "target@example.com",
      canUseSaleDm: true,
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("売却DMを使えない利用者は canUseSaleDm=false を返す", async () => {
    read();
    (checkSaleDmAccessFor as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: "permission" });
    const res = await GET(new Request("http://x") as never, params());
    const json = await res.json();
    expect(json.data.canUseSaleDm).toBe(false);
  });
});

describe("PUT /api/admin/users/:id/inquiry-notify", () => {
  it("user_management:write が無ければ403・保存しない", async () => {
    forbidden();
    const res = await PUT(putReq({ enabled: true }), params());
    expect(res.status).toBe(403);
    expect(pm.user.update).not.toHaveBeenCalled();
  });

  it("対象ユーザーが無ければ404", async () => {
    write();
    pm.user.findUnique.mockResolvedValue(null);
    const res = await PUT(putReq({ enabled: true }), params());
    expect(res.status).toBe(404);
  });

  it("email が不正な形式なら422・保存しない", async () => {
    write();
    const res = await PUT(putReq({ email: "not-mail" }), params());
    expect(res.status).toBe(422);
    expect(pm.user.update).not.toHaveBeenCalled();
  });

  it('email: "" は null として保存する(ログインの email を使う)', async () => {
    write();
    await PUT(putReq({ email: "" }), params());
    const data = pm.user.update.mock.calls[0][0].data;
    expect(data.inquiryNotifyEmail).toBeNull();
  });

  it("email: null も null として保存する", async () => {
    write();
    await PUT(putReq({ email: null }), params());
    const data = pm.user.update.mock.calls[0][0].data;
    expect(data.inquiryNotifyEmail).toBeNull();
  });

  it("正しい形式の email はそのまま保存する", async () => {
    write();
    await PUT(putReq({ email: "notify@example.com" }), params());
    const data = pm.user.update.mock.calls[0][0].data;
    expect(data.inquiryNotifyEmail).toBe("notify@example.com");
  });

  it("enabled=true でも canUseSaleDm=false の利用者は保存できる(応答のcanUseSaleDmはfalse)", async () => {
    write();
    (checkSaleDmAccessFor as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: "permission" });
    const res = await PUT(putReq({ enabled: true }), params());
    expect(res.status).toBe(200);
    const data = pm.user.update.mock.calls[0][0].data;
    expect(data.inquiryNotifyEnabled).toBe(true);
    const json = await res.json();
    expect(json.data.canUseSaleDm).toBe(false);
  });

  it("実際に来たフィールドだけを監査 changedFields に載せる(値=メールアドレスは含めない)", async () => {
    write();
    await PUT(putReq({ email: "secret-notify@example.com" }), params());
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.action).toBe("user_update");
    expect(audit.detail.changedFields).toEqual(["inquiryNotifyEmail"]);
    expect(JSON.stringify(audit.detail)).not.toContain("secret-notify@example.com");
  });

  it("enabled と email を両方送ったときは両方 changedFields に載る", async () => {
    write();
    await PUT(putReq({ enabled: true, email: "a@example.com" }), params());
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.detail.changedFields).toEqual(["inquiryNotifyEnabled", "inquiryNotifyEmail"]);
  });

  it("何も来なければ保存も監査もしない", async () => {
    write();
    const res = await PUT(putReq({}), params());
    expect(res.status).toBe(200);
    expect(pm.user.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
