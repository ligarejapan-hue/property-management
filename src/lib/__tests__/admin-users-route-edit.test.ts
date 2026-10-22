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
    apiResponse: (d: unknown, status = 200) => Response.json(d, { status }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e) return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const m: Record<string, unknown> = {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), count: vi.fn() },
    permissionChangeLog: { create: vi.fn() },
    $executeRaw: vi.fn(async () => 0),
  };
  // トランザクションの中でも同じ偽物を使う
  m.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(m));
  return { default: m };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../../app/api/admin/users/route";
import { PATCH } from "../../app/api/admin/users/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  user: { findUnique: Fn; update: Fn; create: Fn; count: Fn };
  permissionChangeLog: { create: Fn };
  $transaction: Fn;
  $executeRaw: Fn;
};
const req = (method: string, b: unknown) => new Request("http://x", { method, body: JSON.stringify(b) }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "admin-1" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.user.update.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "x", ...a.data }));
  pm.user.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "new", ...a.data }));
});

describe("POST /api/admin/users — 無効にした人と同じメール", () => {
  it("無効のユーザーが使っているメールなら 409 INACTIVE_USER_EXISTS と、その人の id・名前を返す(作らない)", async () => {
    pm.user.findUnique.mockResolvedValue({ id: "u-old", name: "旧 太郎", isActive: false });
    const res = await POST(req("POST", { email: "old@example.com", name: "新", role: "office_staff", password: "password123" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INACTIVE_USER_EXISTS");
    expect(body.error.user).toEqual({ id: "u-old", name: "旧 太郎" });
    expect(body.error.message).toContain("旧 太郎");
    expect(pm.user.create).not.toHaveBeenCalled();
  });
  it("有効のユーザーが使っているメールは従来どおり 409 CONFLICT(id は返さない)", async () => {
    pm.user.findUnique.mockResolvedValue({ id: "u-act", name: "今 花子", isActive: true });
    const res = await POST(req("POST", { email: "act@example.com", name: "新", role: "office_staff", password: "password123" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.user).toBeUndefined();
  });
  it("前後の空白を落として探す・保存する", async () => {
    pm.user.findUnique.mockResolvedValue(null);
    const res = await POST(req("POST", { email: "  new@example.com ", name: " 新 ", role: "office_staff", password: "password123" }));
    expect(res.status).toBe(201);
    expect(pm.user.findUnique.mock.calls[0][0].where).toEqual({ email: "new@example.com" });
    expect(pm.user.create.mock.calls[0][0].data.email).toBe("new@example.com");
    expect(pm.user.create.mock.calls[0][0].data.name).toBe("新");
  });
});

describe("PATCH /api/admin/users/:id — 編集の守り", () => {
  const target = (o: Record<string, unknown> = {}) => ({ id: "u-t", email: "t@example.com", name: "対象", role: "admin", isActive: true, ...o });

  it("最後の有効な管理者を管理者以外にすると 400 LAST_ADMIN で、書き込まない", async () => {
    pm.user.findUnique.mockResolvedValue(target());
    pm.user.count.mockResolvedValue(0);
    const res = await PATCH(req("PATCH", { role: "office_staff" }), params("u-t"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("LAST_ADMIN");
    expect(pm.user.update).not.toHaveBeenCalled();
  });
  it("最後の有効な管理者は無効化できない", async () => {
    pm.user.findUnique.mockResolvedValue(target());
    pm.user.count.mockResolvedValue(0);
    const res = await PATCH(req("PATCH", { isActive: false }), params("u-t"));
    expect((await res.json()).error.code).toBe("LAST_ADMIN");
    expect(pm.user.update).not.toHaveBeenCalled();
  });
  it("自分の役割は変えられない", async () => {
    pm.user.findUnique.mockResolvedValue(target({ id: "admin-1" }));
    pm.user.count.mockResolvedValue(5);
    const res = await PATCH(req("PATCH", { role: "field_staff" }), params("admin-1"));
    expect((await res.json()).error.code).toBe("SELF_ROLE");
    expect(pm.user.update).not.toHaveBeenCalled();
  });
  it("ほかに管理者がいれば役割を変えられ、権限の変更履歴が残る", async () => {
    pm.user.findUnique.mockResolvedValueOnce(target()).mockResolvedValue(null);
    pm.user.count.mockResolvedValue(2);
    const res = await PATCH(req("PATCH", { role: "office_staff", name: "対象", email: "t@example.com" }), params("u-t"));
    expect(res.status).toBe(200);
    expect(pm.user.update.mock.calls[0][0].data.role).toBe("office_staff");
    expect(pm.permissionChangeLog.create).toHaveBeenCalledTimes(1);
  });
  it("メールを別の人が使っていたら 409 CONFLICT", async () => {
    pm.user.findUnique.mockResolvedValueOnce(target({ role: "office_staff" })).mockResolvedValueOnce({ id: "other" });
    const res = await PATCH(req("PATCH", { email: "dup@example.com" }), params("u-t"));
    expect(res.status).toBe(409);
    expect(pm.user.update).not.toHaveBeenCalled();
  });
  it("有効に戻すときは新しいパスワードを同じ書き込みで入れる(古いパスワードで入れる間を作らない・@review P2)", async () => {
    pm.user.findUnique.mockResolvedValue(target({ role: "field_staff", isActive: false }));
    const res = await PATCH(req("PATCH", { isActive: true, newPassword: "newpass123" }), params("u-t"));
    expect(res.status).toBe(200);
    expect(pm.user.update).toHaveBeenCalledTimes(1);
    const data = pm.user.update.mock.calls[0][0].data;
    expect(data.isActive).toBe(true);
    expect(typeof data.passwordHash).toBe("string");
    expect(data.passwordHash).not.toBe("newpass123");
    expect(data).toMatchObject({ mustChangePassword: true, loginFailedCount: 0, lockedUntil: null });
  });
  it("newPassword は8文字未満なら 422 で書き込まない", async () => {
    pm.user.findUnique.mockResolvedValue(target({ role: "field_staff", isActive: false }));
    const res = await PATCH(req("PATCH", { isActive: true, newPassword: "short" }), params("u-t"));
    expect(res.status).toBe(422);
    expect(pm.user.update).not.toHaveBeenCalled();
  });
  it("管理者を減らす変更は、鍵(advisory lock)を取ったトランザクションの中で数えて書く(同時に2人を外して0人にしない・@review P2)", async () => {
    pm.user.findUnique.mockResolvedValue(target());
    pm.user.count.mockResolvedValue(1);
    const res = await PATCH(req("PATCH", { role: "office_staff" }), params("u-t"));
    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(pm.$executeRaw).toHaveBeenCalledTimes(1);
    const lockOrder = pm.$executeRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(pm.user.count.mock.invocationCallOrder[0]);
    expect(pm.user.count.mock.invocationCallOrder[0]).toBeLessThan(pm.user.update.mock.invocationCallOrder[0]);
  });
  it("有効に戻すときに名前と役割も一緒に変えられる", async () => {
    pm.user.findUnique.mockResolvedValue(target({ role: "field_staff", isActive: false }));
    const res = await PATCH(req("PATCH", { isActive: true, name: "新しい名前", role: "office_staff" }), params("u-t"));
    expect(res.status).toBe(200);
    expect(pm.user.update.mock.calls[0][0].data).toMatchObject({ isActive: true, name: "新しい名前", role: "office_staff" });
  });
});
