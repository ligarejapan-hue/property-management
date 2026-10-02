import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: { nextAction: { findMany: vi.fn(async () => []) } } }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/next-actions/mine/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { nextAction: { findMany: Fn } };
const U = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
  pm.nextAction.findMany.mockResolvedValue([]);
});

describe("自分の次回対応(ホームの一覧)", () => {
  it("property:read が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET()).status).toBe(403);
    expect(pm.nextAction.findMany).not.toHaveBeenCalled();
  });
  it("自分が担当・未完了・予定日が日本時間の今日まで。field_staff は物件の担当範囲", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T15:30:00Z")); // 日本時間 10/3
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
    await GET();
    expect(pm.nextAction.findMany.mock.calls[0][0].where).toEqual({
      assignedTo: U,
      isCompleted: false,
      scheduledAt: { lte: new Date("2026-10-03T00:00:00.000Z") },
      property: { OR: [{ createdBy: U }, { assignedTo: U }] },
    });
  });
  it("自由記述の content は読まない・返さない。期限切れの印と物件の所在を返す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T03:00:00Z"));
    pm.nextAction.findMany.mockResolvedValue([
      { id: "a1", propertyId: "p1", scheduledAt: new Date("2026-10-01T00:00:00Z"), actionType: "電話", property: { address: "東京都○○区1-2-3" } },
      { id: "a2", propertyId: "p2", scheduledAt: new Date("2026-10-02T00:00:00Z"), actionType: null, property: { address: "東京都△△区4-5-6" } },
    ]);
    const res = await GET();
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(JSON.stringify(pm.nextAction.findMany.mock.calls[0][0].select)).not.toContain("content");
    expect(body.items).toEqual([
      { id: "a1", propertyId: "p1", scheduledAt: "2026-10-01", actionType: "電話", overdue: true, address: "東京都○○区1-2-3" },
      { id: "a2", propertyId: "p2", scheduledAt: "2026-10-02", actionType: null, overdue: false, address: "東京都△△区4-5-6" },
    ]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
