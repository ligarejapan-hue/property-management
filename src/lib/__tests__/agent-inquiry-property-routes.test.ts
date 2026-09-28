import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(async () => null) },
    agentInquiry: { findMany: vi.fn(async () => []) },
    propertyAdPermission: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { GET as TIMELINE } from "../../app/api/properties/[id]/agent-inquiries/route";
import { PUT } from "../../app/api/properties/[id]/ad-permissions/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  property: { findUnique: Fn };
  agentInquiry: { findMany: Fn };
  propertyAdPermission: { findMany: Fn; upsert: Fn; deleteMany: Fn };
  $transaction: Fn;
};
const PID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: PID }) };
const perms = (...p: [string, string][]) =>
  (getUserPermissions as Fn).mockResolvedValue(p.map(([resource, action]) => ({ resource, action, granted: true })));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: null });
});

describe("物件画面の反響欄", () => {
  it("現地スタッフの担当外は 403", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    perms(["property", "read"]);
    pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: "y" });
    expect((await TIMELINE(new Request("http://x"), ctx)).status).toBe(403);
  });
  it("物件の閲覧権限が無ければ 403(反響の受付の権限だけでは見られない)", async () => {
    perms(["agent_inquiry", "read"]);
    expect((await TIMELINE(new Request("http://x"), ctx)).status).toBe(403);
  });
  it("時系列・件数・広告の可否を返す", async () => {
    perms(["property", "read"]);
    pm.propertyAdPermission.findMany.mockResolvedValue([{ medium: "athome", value: "ok" }]);
    const body = await (await TIMELINE(new Request("http://x"), ctx)).json();
    expect(body).toEqual({
      counts: { total: 0, guided: 0, preview: 0, materialRequest: 0, adPermission: 0 },
      timeline: [],
      adPermissions: { athome: "ok" },
    });
  });
});

describe("広告の可否の変更", () => {
  it("物件の編集権限・null は行を消す・1トランザクション", async () => {
    perms(["property", "read"], ["property", "write"]);
    const res = await PUT(json("PUT", { items: [{ medium: "athome", value: "ok" }, { medium: "flyer", value: null }] }), ctx);
    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalled();
    expect(pm.propertyAdPermission.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { propertyId_medium: { propertyId: PID, medium: "athome" } },
      create: { propertyId: PID, medium: "athome", value: "ok", updatedById: "u1" },
      update: { value: "ok", updatedById: "u1" },
    }));
    expect(pm.propertyAdPermission.deleteMany).toHaveBeenCalledWith({ where: { propertyId: PID, medium: "flyer" } });
  });
  it("反響の受付の権限だけでは変えられない(403)", async () => {
    perms(["property", "read"], ["agent_inquiry", "write"]);
    expect((await PUT(json("PUT", { items: [{ medium: "athome", value: "ok" }] }), ctx)).status).toBe(403);
    expect(pm.propertyAdPermission.upsert).not.toHaveBeenCalled();
  });
  it("現地スタッフの担当外は変えられない(403)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    perms(["property", "read"], ["property", "write"]);
    pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: "y" });
    expect((await PUT(json("PUT", { items: [{ medium: "athome", value: "ok" }] }), ctx)).status).toBe(403);
  });
});
