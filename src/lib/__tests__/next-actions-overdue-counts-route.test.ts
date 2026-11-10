import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: { $queryRaw: vi.fn(async () => []) } }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/next-actions/mine/overdue-counts/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { $queryRaw: Fn };
const U = "11111111-1111-4111-8111-111111111111";

function lastQuery(): { sql: string; values: unknown[] } {
  const [strings, ...values] = pm.$queryRaw.mock.calls.at(-1) as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join("?").replace(/\s+/g, " "), values };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
  pm.$queryRaw.mockResolvedValue([{ total: 5, within3: 3, within7: 1, older: 1 }]);
});

describe("自分の期限切れの次回対応の件数(ホームの重要な数字)", () => {
  it("property:read が無ければ 403(数えない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET()).status).toBe(403);
    expect(pm.$queryRaw).not.toHaveBeenCalled();
  });
  it("件数と経過日数の内訳だけを返す(所在・内容は返さない)", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ total: 5, within3: 3, within7: 1, older: 1 });
    const { sql } = lastQuery();
    expect(sql).not.toMatch(/"address"|"content"/);
  });
  it("0件(行が無い)でも 0 を返す", async () => {
    pm.$queryRaw.mockResolvedValue([]);
    expect(await (await GET()).json()).toEqual({ total: 0, within3: 0, within7: 0, older: 0 });
  });
  it("自分が担当・未完了。期限切れは /mine と同じ判定(時刻ありはその時刻、時刻なしは前日まで)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T16:30:00Z")); // 日本時間 11/10 1:30
    await GET();
    const { sql, values } = lastQuery();
    expect(sql).toMatch(/na\."assigned_to" = \?::uuid/);
    expect(sql).toMatch(/na\."is_completed" = false/);
    expect(sql).toMatch(/\(na\."scheduled_time" IS NULL AND na\."scheduled_at" < \?::date\)/);
    expect(sql).toMatch(/\(\(na\."scheduled_at" \+ na\."scheduled_time"::time\) AT TIME ZONE 'Asia\/Tokyo'\) < \?::timestamptz/);
    // 値: 今日(経過日数の起点)・自分・今日・今の時刻(Z 付き)
    expect(values.slice(0, 4)).toEqual(["2026-11-10", U, "2026-11-10", "2026-11-09T16:30:00.000Z"]);
  });
  it("経過日数の区切りは 3日以内・4〜7日・8日以上", async () => {
    await GET();
    const { sql } = lastQuery();
    expect(sql).toMatch(/FILTER \(WHERE days <= 3\)/);
    expect(sql).toMatch(/FILTER \(WHERE days BETWEEN 4 AND 7\)/);
    expect(sql).toMatch(/FILTER \(WHERE days >= 8\)/);
  });
  it("field_staff だけ物件の担当範囲で絞る(それ以外は絞らない)", async () => {
    await GET();
    expect(lastQuery().values[4]).toBeNull();
    (getApiSession as Fn).mockResolvedValue({ id: U, role: "field_staff" });
    await GET();
    const { sql, values } = lastQuery();
    expect(sql).toMatch(/\(\?::uuid IS NULL OR p\."created_by" = \?::uuid OR p\."assigned_to" = \?::uuid\)/);
    expect(values.slice(4, 7)).toEqual([U, U, U]);
  });
});
