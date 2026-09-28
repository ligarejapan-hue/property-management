import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(async () => null) },
    agentInquiry: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    agentViewing: { groupBy: vi.fn(async () => []) },
    propertyAdPermission: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "locked" }]);
  return { default: db };
});

const { lockPropertyRecordForWrite } = vi.hoisted(() => ({ lockPropertyRecordForWrite: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRecordForWrite }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { GET as TIMELINE } from "../../app/api/properties/[id]/agent-inquiries/route";
import { PUT } from "../../app/api/properties/[id]/ad-permissions/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  property: { findUnique: Fn };
  agentInquiry: { findMany: Fn; groupBy: Fn };
  agentViewing: { groupBy: Fn };
  propertyAdPermission: { findMany: Fn; upsert: Fn; deleteMany: Fn };
  $transaction: Fn;
  $queryRaw: Fn;
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
  it("件数は時系列(500件まで)ではなく集計クエリで数える・取り消した内見は除く", async () => {
    perms(["property", "read"]);
    pm.agentInquiry.groupBy.mockResolvedValueOnce([{ kind: "viewing", _count: { _all: 600 } }]);
    pm.agentViewing.groupBy.mockResolvedValueOnce([{ viewingType: "guided", _count: { _all: 590 } }]);
    const body = await (await TIMELINE(new Request("http://x"), ctx)).json();
    expect(body.counts).toEqual({ total: 600, guided: 590, preview: 0, materialRequest: 0, adPermission: 0 });
    expect(pm.agentViewing.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { canceledAt: null, inquiry: { propertyId: PID } },
    }));
  });
  it("時系列は受けた日時で先に切らない(内見の予定日時で並べてから上限をかける・@codex #454 R3)", async () => {
    perms(["property", "read"]);
    await TIMELINE(new Request("http://x"), ctx);
    expect(pm.agentInquiry.findMany.mock.calls[0][0].take).toBeUndefined();
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
  it("画面に出ていた値と今の値が違えば 409(古い画面からの上書きを止める・@codex #454 R5)", async () => {
    perms(["property", "read"], ["property", "write"]);
    pm.propertyAdPermission.findMany.mockResolvedValueOnce([{ medium: "athome", value: "ng" }]);
    const res = await PUT(json("PUT", { items: [{ medium: "athome", value: "ok", from: null }] }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
    expect(pm.propertyAdPermission.upsert).not.toHaveBeenCalled();
    // 同時保存で比べる前に割り込まれないよう、物件の行を先にロックする(担当範囲つき)
    expect(lockPropertyRecordForWrite).toHaveBeenCalledWith(expect.anything(), PID, expect.objectContaining({ id: "u1" }));
  });
  it("物件の編集権限・null は行を消す・1トランザクション", async () => {
    perms(["property", "read"], ["property", "write"]);
    pm.propertyAdPermission.findMany.mockResolvedValueOnce([{ medium: "flyer", value: "ng" }]);
    const res = await PUT(json("PUT", { items: [{ medium: "athome", value: "ok", from: null }, { medium: "flyer", value: null, from: "ng" }] }), ctx);
    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalled();
    expect(pm.propertyAdPermission.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { propertyId_medium: { propertyId: PID, medium: "athome" } },
      create: { propertyId: PID, medium: "athome", value: "ok", updatedById: "u1" },
      update: { value: "ok", updatedById: "u1" },
    }));
    expect(pm.propertyAdPermission.deleteMany).toHaveBeenCalledWith({ where: { propertyId: PID, medium: "flyer" } });
  });
  it("監査と応答はロック中に組み立てた値(ロックを外した後の他人の変更を混ぜない・@codex #454 R6)", async () => {
    perms(["property", "read"], ["property", "write"]);
    pm.propertyAdPermission.findMany
      .mockResolvedValueOnce([{ medium: "suumo", value: "ask" }])
      .mockResolvedValueOnce([{ medium: "athome", value: "ng" }, { medium: "suumo", value: "ng" }]);
    const res = await PUT(json("PUT", { items: [{ medium: "athome", value: "ok", from: null }] }), ctx);
    const want = { athome: "ok", suumo: "ask" };
    expect((await res.json()).adPermissions).toEqual(want);
    expect((writeAuditLog as Fn).mock.calls.at(-1)![0].detail.values).toEqual(want);
    expect(pm.propertyAdPermission.findMany).toHaveBeenCalledTimes(1);
  });
  it("ロック後に担当範囲を外れていたら書かない(認可と書き込みを同じロックの中で・@codex #454 R9)", async () => {
    perms(["property", "read"], ["property", "write"]);
    const { ApiError } = await import("@/lib/api-helpers");
    lockPropertyRecordForWrite.mockRejectedValueOnce(new (ApiError as never as new (s: number, m: string, c: string) => Error)(403, "x", "FORBIDDEN"));
    const res = await PUT(json("PUT", { items: [{ medium: "athome", value: "ok", from: null }] }), ctx);
    expect(res.status).toBe(403);
    expect(pm.propertyAdPermission.upsert).not.toHaveBeenCalled();
  });
  it("反響の受付の権限だけでは変えられない(403)", async () => {
    perms(["property", "read"], ["agent_inquiry", "write"]);
    expect((await PUT(json("PUT", { items: [{ medium: "athome", value: "ok", from: null }] }), ctx)).status).toBe(403);
    expect(pm.propertyAdPermission.upsert).not.toHaveBeenCalled();
  });
  it("現地スタッフの担当外は変えられない(403)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    perms(["property", "read"], ["property", "write"]);
    pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: "y" });
    expect((await PUT(json("PUT", { items: [{ medium: "athome", value: "ok", from: null }] }), ctx)).status).toBe(403);
  });
});
