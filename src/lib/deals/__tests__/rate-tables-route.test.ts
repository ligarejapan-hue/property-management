import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dealRateTable: {
      findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333" })),
      updateMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    $executeRaw: vi.fn(async () => 1),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./route-mocks";
import { POST } from "../../../app/api/admin/deal-settings/rate-tables/route";
import { PUT, DELETE } from "../../../app/api/admin/deal-settings/rate-tables/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dealRateTable: { findMany: Fn; findUnique: Fn; create: Fn; updateMany: Fn; deleteMany: Fn }; $executeRaw: Fn };
const ID = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: ID }) };
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const AT = "2026-10-24T00:00:00.000Z";
const existing = (from: string, to: string | null, id = "44444444-4444-4444-8444-444444444444") => ({
  id, kind: "consumption_tax", validFrom: new Date(`${from}T00:00:00Z`), validTo: to ? new Date(`${to}T00:00:00Z`) : null,
});

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(ADMIN);
  pm.dealRateTable.updateMany.mockResolvedValue({ count: 1 });
  pm.dealRateTable.deleteMany.mockResolvedValue({ count: 1 });
});

describe("税率の表を足す・直す・消す(管理者)", () => {
  it("足す: 期間が重ならなければ作る・監査は項目名だけ", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([existing("2019-10-01", "2029-12-31")]);
    const res = await POST(json("POST", { kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: 1200 } }));
    expect(res.status).toBe(201);
    expect(pm.dealRateTable.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "consumption_tax", content: { rateBp: 1200 }, updatedById: "u-admin" }) }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_rate_table_create", targetTable: "deal_rate_tables" }));
  });
  it("足す: 期間が重なれば 422", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([existing("2019-10-01", null)]);
    const res = await POST(json("POST", { kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: 1200 } }));
    expect(res.status).toBe(422);
    expect(pm.dealRateTable.create).not.toHaveBeenCalled();
  });
  it("直す: 自分は重なりの相手にしない・更新日時が合わなければ 409", async () => {
    pm.dealRateTable.findUnique.mockResolvedValue({ ...existing("2019-10-01", null, ID), updatedAt: new Date(AT) });
    pm.dealRateTable.findMany.mockResolvedValue([existing("2019-10-01", null, ID)]);
    const res = await PUT(json("PUT", { validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 }, updatedAt: AT }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealRateTable.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ID, updatedAt: new Date(AT) } }));
    pm.dealRateTable.updateMany.mockResolvedValue({ count: 0 });
    expect((await PUT(json("PUT", { validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 }, updatedAt: AT }), ctx)).status).toBe(409);
  });
  it("消す: 更新日時を見る・管理者でなければ 403", async () => {
    pm.dealRateTable.findUnique.mockResolvedValue({ ...existing("2019-10-01", null, ID), updatedAt: new Date(AT) });
    const res = await DELETE(new Request(`http://x/api?updatedAt=${encodeURIComponent(AT)}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealRateTable.deleteMany).toHaveBeenCalledWith({ where: { id: ID, updatedAt: new Date(AT) } });
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await DELETE(new Request(`http://x/api?updatedAt=${encodeURIComponent(AT)}`, { method: "DELETE" }), ctx)).status).toBe(403);
  });
});

describe("@codex 2巡目: 期間の確かめと書き込みを種類ごとに1つずつ", () => {
  it("足す・直すは、種類の鍵を取ってから重なりを確かめる", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([]);
    await POST(json("POST", { kind: "consumption_tax", validFrom: "2030-01-01", validTo: null, content: { rateBp: 1200 } }));
    expect(pm.$executeRaw).toHaveBeenCalledTimes(1);
    expect(pm.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(pm.dealRateTable.findMany.mock.invocationCallOrder[0]);
    pm.dealRateTable.findUnique.mockResolvedValue({ ...existing("2019-10-01", null, ID), updatedAt: new Date(AT) });
    await PUT(json("PUT", { validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 }, updatedAt: AT }), ctx);
    expect(pm.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
