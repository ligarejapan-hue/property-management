import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: { $queryRaw: vi.fn(async () => []) } }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/next-actions/mine/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { $queryRaw: Fn };
const U = "11111111-1111-4111-8111-111111111111";

/** $queryRaw のタグ付きテンプレートを「SQL の文字列」と「値」に分ける。 */
function lastQuery(): { sql: string; values: unknown[] } {
  const [strings, ...values] = pm.$queryRaw.mock.calls.at(-1) as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join("?"), values };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
  pm.$queryRaw.mockResolvedValue([]);
});

describe("自分の次回対応(ホームの一覧)", () => {
  it("property:read が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET()).status).toBe(403);
    expect(pm.$queryRaw).not.toHaveBeenCalled();
  });
  it("自分が担当・未完了・予定日が日本時間の今日まで", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T15:30:00Z")); // 日本時間 10/3
    await GET();
    const { sql, values } = lastQuery();
    expect(sql).toMatch(/na\."assigned_to" = \?::uuid/);
    expect(sql).toMatch(/na\."is_completed" = false/);
    expect(sql).toMatch(/na\."scheduled_at" <= \?::date/);
    expect(values[0]).toBe(U);
    expect(values[1]).toEqual(new Date("2026-10-03T00:00:00.000Z"));
  });
  it("field_staff だけ物件の担当範囲で絞る(それ以外は絞らない)", async () => {
    await GET();
    expect(lastQuery().values[2]).toBeNull();
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
    await GET();
    const { sql, values } = lastQuery();
    expect(sql).toMatch(/\(\?::uuid IS NULL OR p\."created_by" = \?::uuid OR p\."assigned_to" = \?::uuid\)/);
    expect(values.slice(2, 5)).toEqual([U, U, U]);
  });
  it("並びは予定日 → 時刻(時刻なしは 9:00) → id(@codex #470 P2)", async () => {
    await GET();
    expect(lastQuery().sql).toMatch(/ORDER BY na\."scheduled_at" ASC, COALESCE\(na\."scheduled_time", '09:00'\) ASC, na\."id" ASC/);
  });
  it("自由記述の content は読まない・返さない。期限切れの印・時刻・物件の所在を返す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T03:00:00Z"));
    pm.$queryRaw.mockResolvedValue([
      { id: "a1", property_id: "p1", scheduled_at: new Date("2026-10-01T00:00:00Z"), scheduled_time: null, action_type: "電話", address: "東京都○○区1-2-3" },
      { id: "a2", property_id: "p2", scheduled_at: new Date("2026-10-02T00:00:00Z"), scheduled_time: "15:00", action_type: null, address: "東京都△△区4-5-6" },
    ]);
    const res = await GET();
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(lastQuery().sql).not.toContain("content");
    expect(body.items).toEqual([
      { id: "a1", propertyId: "p1", scheduledAt: "2026-10-01", scheduledTime: null, actionType: "電話", overdue: true, address: "東京都○○区1-2-3" },
      { id: "a2", propertyId: "p2", scheduledAt: "2026-10-02", scheduledTime: "15:00", actionType: null, overdue: false, address: "東京都△△区4-5-6" },
    ]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
