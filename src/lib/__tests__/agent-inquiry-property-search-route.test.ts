import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: { property: { findMany: vi.fn(async () => []) } } }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET as SEARCH } from "../../app/api/agent-inquiries/property-search/route";
import { DESK_PROPERTY_SELECT } from "@/lib/agent-inquiry/desk-property";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { property: { findMany: Fn } };
const url = (q: string) => new Request("http://x/api/agent-inquiries/property-search?q=" + encodeURIComponent(q));
const whereOf = () => pm.property.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "agent_inquiry", action: "read", granted: true }]);
});

describe("受付の窓の物件検索", () => {
  it("現地スタッフでも担当外を含む全物件が対象(作成者/担当の条件を付けない)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    await SEARCH(url("サンライズ"));
    expect(JSON.stringify(whereOf())).not.toMatch(/createdBy|assignedTo/);
  });
  it("検索条件は物件名・棟名・部屋番号・所在地だけ(所有者・地番・メモで当たらない)・しまった物件は除く", async () => {
    await SEARCH(url("中野"));
    const arg = pm.property.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      isArchived: false,
      AND: [{
        OR: [
          { buildingName: { contains: "中野", mode: "insensitive" } },
          { building: { name: { contains: "中野", mode: "insensitive" } } },
          { roomNo: { contains: "中野" } },
          { address: { contains: "中野", mode: "insensitive" } },
        ],
      }],
    });
    expect(JSON.stringify(arg.where)).not.toMatch(/owner|lotNumber|note/i);
    expect(arg.select).toEqual(DESK_PROPERTY_SELECT);
    expect(arg.take).toBe(20);
  });
  it("空白区切りは語ごとに AND", async () => {
    await SEARCH(url("サンライズ　305"));
    expect(whereOf().AND).toHaveLength(2);
  });
  it("返すのは許可リストのキーだけ", async () => {
    pm.property.findMany.mockResolvedValue([{
      id: "p", propertyType: "land", buildingName: null, roomNo: null,
      address: "東京都中野区中野2丁目3", building: null, adPermissions: [], salePrice: 9,
    }]);
    const body = await (await SEARCH(url("ab"))).json();
    expect(Object.keys(body.properties[0]).sort()).toEqual(["adPermissions", "id", "name", "propertyType", "roomNo", "town"]);
  });
  it("権限が無ければ 403・1文字は検索しない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await SEARCH(url("ab"))).status).toBe(403);
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "agent_inquiry", action: "read", granted: true }]);
    expect((await (await SEARCH(url("a"))).json()).properties).toEqual([]);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });
});
