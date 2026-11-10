import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({
  default: { property: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) } },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/home/case-kanban/route";
import { KANBAN_STATUSES } from "@/lib/home/case-kanban";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { property: { groupBy: Fn; findMany: Fn } };
const U = "11111111-1111-4111-8111-111111111111";
const req = (q = "") => new Request(`http://localhost/api/home/case-kanban${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
  pm.property.groupBy.mockResolvedValue([]);
  pm.property.findMany.mockResolvedValue([]);
});

describe("ホームの案件の進み具合 API(案2)", () => {
  it("property:read が無ければ 403(読まない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(req())).status).toBe(403);
    expect(pm.property.groupBy).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });
  it("列は進行中の7段階(この順)。件数は groupBy、カードは各列3件・更新の新しい順", async () => {
    pm.property.groupBy.mockResolvedValue([
      { caseStatus: "appraisal", _count: { _all: 5 } },
      { caseStatus: "on_sale", _count: { _all: 1 } },
    ]);
    pm.property.findMany.mockImplementation(async ({ where }: { where: { caseStatus: string } }) =>
      where.caseStatus === "appraisal"
        ? [{ id: "p1", address: "東京都中野区1", updatedAt: new Date("2026-11-09T03:00:00Z"), assignee: { name: "山田" } }]
        : [],
    );
    const body = await (await GET(req())).json();
    expect(body.columns.map((c: { status: string }) => c.status)).toEqual([
      "contact_attempting", "contacting_owner", "appraisal", "negotiating", "brokerage_obtained", "on_sale", "contract_planned",
    ]);
    expect(body.columns.map((c: { label: string }) => c.label)).toEqual([
      "コンタクト中", "所有者とやりとり中", "査定中", "商談中", "媒介取得", "販売中", "契約予定",
    ]);
    const ap = body.columns[2];
    expect(ap.count).toBe(5);
    expect(ap.cards).toEqual([{ id: "p1", address: "東京都中野区1", assigneeName: "山田", updatedAt: "2026-11-09T03:00:00.000Z" }]);
    expect(body.columns[0].count).toBe(0);
    expect(body.mine).toBe(false);
    expect(body.selfId).toBe(U);
    const g = pm.property.groupBy.mock.calls[0][0];
    expect(g.where).toMatchObject({ isArchived: false, caseStatus: { in: [...KANBAN_STATUSES] } });
    expect(pm.property.findMany).toHaveBeenCalledTimes(7);
    const f = pm.property.findMany.mock.calls[0][0];
    expect(f.take).toBe(3);
    expect(f.orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }]);
  });
  it("所有者・座標・rawData は読まない(カードは所在・担当者名・更新日だけ)", async () => {
    await GET(req());
    const sel = JSON.stringify(pm.property.findMany.mock.calls[0][0].select);
    expect(sel).toBe(JSON.stringify({ id: true, address: true, updatedAt: true, assignee: { select: { name: true } } }));
  });
  it("mine=1 は自分が担当の物件だけ", async () => {
    const body = await (await GET(req("?mine=1"))).json();
    expect(body.mine).toBe(true);
    expect(pm.property.groupBy.mock.calls[0][0].where.assignedTo).toBe(U);
    expect(pm.property.findMany.mock.calls[0][0].where.assignedTo).toBe(U);
  });
  it("field_staff は物件一覧と同じ見える範囲(作成 or 担当)で絞る。それ以外は絞らない", async () => {
    await GET(req());
    expect(pm.property.groupBy.mock.calls[0][0].where.AND).toBeUndefined();
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
    await GET(req());
    const scope = { OR: [{ createdBy: U }, { assignedTo: U }] };
    expect(pm.property.groupBy.mock.calls[1][0].where.AND).toEqual([scope]);
    expect(pm.property.findMany.mock.calls.at(-1)![0].where.AND).toEqual([scope]);
  });
});
