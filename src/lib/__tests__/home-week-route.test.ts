import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({
  default: {
    nextAction: { findMany: vi.fn(async () => []) },
    agentViewing: { findMany: vi.fn(async () => []) },
    deal: { findMany: vi.fn(async () => []) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/home/week/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { nextAction: { findMany: Fn }; agentViewing: { findMany: Fn }; deal: { findMany: Fn } };
const U = "11111111-1111-4111-8111-111111111111";
const ALL_PERMS = [
  { resource: "property", action: "read", granted: true },
  { resource: "agent_inquiry", action: "read", granted: true },
  { resource: "deal", action: "read", granted: true },
];
const req = (q = "") => new Request(`http://localhost/api/home/week${q}`);
const body = async (q = "") => (await (await GET(req(q))).json()) as {
  weekStart: string; scope: string; canSeeAll: boolean; hasMore: boolean;
  items: Array<Record<string, unknown>>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T03:00:00Z")); // 日本時間 11/10(火) 12:00
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(ALL_PERMS);
  pm.nextAction.findMany.mockResolvedValue([]);
  pm.agentViewing.findMany.mockResolvedValue([]);
  pm.deal.findMany.mockResolvedValue([]);
});

describe("ホームの今週の予定 API(案4)", () => {
  it("既定は自分・今週(月曜はじまり)", async () => {
    const b = await body();
    expect(b).toMatchObject({ weekStart: "2026-11-09", scope: "mine", canSeeAll: false, items: [], hasMore: false });
    const na = pm.nextAction.findMany.mock.calls[0][0];
    expect(na.where).toMatchObject({ isCompleted: false, assignedTo: U });
    expect(na.where.scheduledAt.gte.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(na.where.scheduledAt.lte.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    const vw = pm.agentViewing.findMany.mock.calls[0][0];
    expect(vw.where).toMatchObject({ canceledAt: null, attendantId: U });
    expect(vw.where.scheduledAt.gte.toISOString()).toBe("2026-11-08T15:00:00.000Z");
    expect(vw.where.scheduledAt.lt.toISOString()).toBe("2026-11-15T15:00:00.000Z");
    const dl = pm.deal.findMany.mock.calls[0][0];
    expect(dl.where.status).toEqual({ not: "cancelled" });
    expect(dl.where.AND[1]).toEqual({ OR: [{ assigneeId: U }, { salesStaffId: U }, { opsStaffId: U }, { licensedAgentId: U }] });
  });
  it("week で週を選べる(どの曜日でもその週の月曜)・形が違えば 422", async () => {
    expect((await body("?week=2026-11-19")).weekStart).toBe("2026-11-16");
    expect((await GET(req("?week=2026-02-30"))).status).toBe(422);
    expect((await GET(req("?scope=everyone"))).status).toBe(422);
  });
  it("全員(scope=all)は管理者だけ。管理者以外は 403 で何も読まない", async () => {
    expect((await GET(req("?scope=all"))).status).toBe(403);
    expect(pm.nextAction.findMany).not.toHaveBeenCalled();
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "admin" });
    const b = await body("?scope=all");
    expect(b.scope).toBe("all");
    expect(b.canSeeAll).toBe(true);
    expect(pm.nextAction.findMany.mock.calls[0][0].where.assignedTo).toBeUndefined();
    expect(pm.agentViewing.findMany.mock.calls[0][0].where.attendantId).toBeUndefined();
    expect(pm.deal.findMany.mock.calls[0][0].where.AND).toHaveLength(1);
  });
  it("権限の無い種類は読まずに空(全体は 403 にしない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
    expect((await GET(req())).status).toBe(200);
    expect(pm.nextAction.findMany).toHaveBeenCalled();
    expect(pm.agentViewing.findMany).not.toHaveBeenCalled();
    expect(pm.deal.findMany).not.toHaveBeenCalled();
    (getUserPermissions as Fn).mockResolvedValue([]);
    vi.clearAllMocks();
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await body()).items).toEqual([]);
    expect(pm.nextAction.findMany).not.toHaveBeenCalled();
  });
  it("field_staff の次回対応は物件の担当範囲で絞る", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
    await body();
    expect(pm.nextAction.findMany.mock.calls[0][0].where.property).toEqual({ OR: [{ createdBy: U }, { assignedTo: U }] });
  });
  it("所有者名・連絡先・自由記述・業者を読まない(select に無い)", async () => {
    await body();
    const sel = JSON.stringify([
      pm.nextAction.findMany.mock.calls[0][0].select,
      pm.agentViewing.findMany.mock.calls[0][0].select,
      pm.deal.findMany.mock.calls[0][0].select,
    ]);
    for (const k of ["content", "owner", "contactName", "contactMobile", "contactEmail", "agent", "parties", "latitude", "longitude", "rawData", "note"]) {
      expect(sel).not.toContain(`"${k}"`);
    }
  });
  it("予定を種類ごとに組み立てる(時刻なしは終日・期限切れの判定・日本時間)", async () => {
    pm.nextAction.findMany.mockResolvedValue([
      { id: "n1", propertyId: "p1", scheduledAt: new Date("2026-11-09T00:00:00Z"), scheduledTime: null, actionType: "電話", property: { address: "東京都中野区1" }, assignee: { name: "山田" } },
      { id: "n2", propertyId: "p2", scheduledAt: new Date("2026-11-10T00:00:00Z"), scheduledTime: "10:00", actionType: null, property: { address: "東京都中野区2" }, assignee: { name: "山田" } },
      { id: "n3", propertyId: "p3", scheduledAt: new Date("2026-11-10T00:00:00Z"), scheduledTime: "15:00", actionType: null, property: { address: "東京都中野区3" }, assignee: { name: "山田" } },
    ]);
    pm.agentViewing.findMany.mockResolvedValue([
      { id: "v1", scheduledAt: new Date("2026-11-11T01:30:00Z"), viewingType: "guided", attendant: { name: "佐藤" },
        inquiry: { property: { address: "東京都中野区中野2丁目3", buildingName: null, roomNo: null, building: { name: "テストハイツ" } } } },
    ]);
    pm.deal.findMany.mockResolvedValue([
      { id: "d1", dealNo: "2026-0009", name: "x", contractAt: new Date("2026-11-12T01:30:00Z"), settlementAt: new Date("2026-12-20T01:00:00Z"),
        propertySnapshot: { buildingName: "テスト荘", roomNo: "101" }, assignee: { name: "鈴木" } },
    ]);
    const b = await body();
    const pick = (k: string) => b.items.find((i) => i.key === k)!;
    expect(pick("na:n1")).toMatchObject({ kind: "next_action", date: "2026-11-09", time: null, overdue: true, sub: "電話", who: null, href: "/properties/p1" });
    expect(pick("na:n2")).toMatchObject({ time: "10:00", overdue: true });
    expect(pick("na:n3")).toMatchObject({ time: "15:00", overdue: false });
    expect(pick("vw:v1")).toMatchObject({ kind: "viewing", date: "2026-11-11", time: "10:30", title: "テストハイツ", sub: "案内", href: "/inquiry-desk", desk: true });
    expect(pick("contract:d1")).toMatchObject({ kind: "contract", date: "2026-11-12", time: "10:30", title: "テスト荘 101", sub: "2026-0009", href: "/deals/d1" });
    // 範囲外の決済は出さない
    expect(b.items.some((i) => i.key === "settlement:d1")).toBe(false);
  });
  it("全員表示では誰の予定かを添える", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "admin" });
    pm.nextAction.findMany.mockResolvedValue([
      { id: "n1", propertyId: "p1", scheduledAt: new Date("2026-11-11T00:00:00Z"), scheduledTime: null, actionType: null, property: { address: "a" }, assignee: { name: "山田" } },
    ]);
    expect((await body("?scope=all")).items[0].who).toBe("山田");
  });
});
