import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dealSettings: { findUnique: vi.fn(async () => null), create: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    dealRateTable: { findMany: vi.fn(async () => []) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./route-mocks";
import { GET, PUT } from "../../../app/api/admin/deal-settings/route";
import { GET as RATES } from "../../../app/api/admin/deal-settings/rate-tables/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dealSettings: { findUnique: Fn; create: Fn; updateMany: Fn };
  dealRateTable: { findMany: Fn };
};
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const row = (v: number) => ({ representativeTitle: "代表取締役", representativeName: "試験 太郎", bankAccount: {}, propertyKinds: [], version: v, updatedAt: new Date("2026-10-24T00:00:00Z") });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(ADMIN);
  pm.dealSettings.updateMany.mockResolvedValue({ count: 1 });
  pm.dealSettings.create.mockResolvedValue({});
});

describe("取引の設定", () => {
  it("管理者でなければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "deal", action: "write", granted: true }]);
    expect((await GET()).status).toBe(403);
    expect((await PUT(json("PUT", { version: 0 }))).status).toBe(403);
  });
  it("初めての保存は行を作る", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(row(1));
    const res = await PUT(json("PUT", { version: 0, representativeName: "試験 太郎" }));
    expect(res.status).toBe(200);
    expect(pm.dealSettings.create).toHaveBeenCalledWith({ data: { id: "singleton", representativeName: "試験 太郎", updatedById: "u-admin" } });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_settings_update", targetTable: "deal_settings", detail: { fields: ["representativeName"] } }));
    expect((writeAuditLog as Fn).mock.calls[0][0].targetId).toBeUndefined();
  });
  it("2回目からは版の番号で書く・古ければ 409", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(row(3));
    await PUT(json("PUT", { version: 2, representativeTitle: "代表" }));
    expect(pm.dealSettings.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", version: 2 },
      data: { representativeTitle: "代表", updatedById: "u-admin", version: { increment: 1 } },
    });
    pm.dealSettings.updateMany.mockResolvedValue({ count: 0 });
    expect((await PUT(json("PUT", { version: 2, representativeTitle: "代表" }))).status).toBe(409);
  });
  it("ほかの人が先に初めての保存をしていたら 409", async () => {
    pm.dealSettings.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await PUT(json("PUT", { version: 0, representativeName: "a" }))).status).toBe(409);
  });
  it("事業計画書の種別×セクションの表: 知っている形だけ保存・ほかは 422 で書かない", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(row(3));
    expect((await PUT(json("PUT", { version: 2, sectionMatrix: { unit: { holding: false } } }))).status).toBe(200);
    expect(pm.dealSettings.updateMany.mock.calls[0][0].data.sectionMatrix).toEqual({ unit: { holding: false } });
    pm.dealSettings.updateMany.mockClear();
    for (const bad of [{ unit: { memo: false } }, { "Bad Key": { holding: false } }, { unit: { holding: "no" } }]) {
      expect((await PUT(json("PUT", { version: 2, sectionMatrix: bad }))).status).toBe(422);
    }
    expect(pm.dealSettings.updateMany).not.toHaveBeenCalled();
  });
});

describe("税率の表", () => {
  it("日付は YYYY-MM-DD で返す", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([
      { id: "r1", kind: "consumption_tax", validFrom: new Date("2019-10-01T00:00:00Z"), validTo: null, content: { rateBp: 1000 }, updatedAt: new Date("2026-10-24T00:00:00Z") },
    ]);
    const body = await (await RATES()).json();
    expect(body.tables).toEqual([{ id: "r1", kind: "consumption_tax", validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 }, updatedAt: "2026-10-24T00:00:00.000Z" }]);
  });
});
