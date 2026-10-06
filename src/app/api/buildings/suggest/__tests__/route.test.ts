import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// GET /api/buildings/suggest(物件名の候補)。mock の形は
// src/app/api/buildings/[id]/__tests__/route-sales-fields.test.ts に合わせる。

let allowed = true;

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => ({ id: "user-1" })),
    getUserPermissions: vi.fn(async () => []),
  };
});
vi.mock("@/lib/permissions", () => ({ hasPermission: () => allowed }));
vi.mock("@/lib/prisma", () => ({ default: { building: { findMany: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { NextRequest } from "next/server";
import { GET } from "../route";

const findMany = (prisma as unknown as { building: { findMany: Mock } }).building.findMany;
const call = (qs: string) => GET(new NextRequest(`http://localhost/api/buildings/suggest?${qs}`));

beforeEach(() => {
  allowed = true;
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe("GET /api/buildings/suggest", () => {
  it("property:read が無いと 403", async () => {
    allowed = false;
    const res = await call("name=" + encodeURIComponent("パーク第一"));
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("name が1文字なら DB を引かずに []", async () => {
    const res = await call("name=" + encodeURIComponent("あ"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("応答に番地が含まれない(町丁目まで)", async () => {
    findMany.mockResolvedValue([
      {
        id: "b1", name: "パーク第１", address: "東京都大田区南雪谷1丁目164-2",
        nameKey: null, areaKey: null, createdAt: new Date("2026-01-01"),
        _count: { properties: 3 },
      },
    ]);
    const res = await call("name=" + encodeURIComponent("パーク第１"));
    const text = JSON.stringify(await res.json());
    expect(text).toContain("東京都大田区南雪谷1丁目");
    expect(text).not.toContain("164");
  });

  it("比較キーが入力キーを含む棟も取りに行く(where に nameKey contains)", async () => {
    findMany.mockResolvedValue([
      {
        id: "b2", name: "パーク第一ハイツ", address: "東京都港区六本木1丁目1",
        nameKey: "パ-ク第1ハイツ", areaKey: "東京都港区六本木1丁目", createdAt: new Date("2026-01-01"),
        _count: { properties: 1 },
      },
    ]);
    const res = await call("name=" + encodeURIComponent("パーク第１"));
    const orCall = findMany.mock.calls.find((c) => Array.isArray(c[0].where.OR));
    expect(orCall).toBeDefined();
    const where = orCall![0].where;
    expect(where.OR).toContainEqual({ nameKey: { contains: "パ-ク第1" } });
    expect((await res.json()).data.map((x: { id: string }) => x.id)).toEqual(["b2"]);
  });

  it("古い棟(nameKey なし)が50件あっても同じ名前の棟が先頭に出る", async () => {
    const row = (id: string, name: string, nameKey: string | null) => ({
      id, name, address: "東京都港区六本木1丁目1", nameKey, areaKey: null,
      createdAt: new Date("2026-01-01"), _count: { properties: 1 },
    });
    const legacy = Array.from({ length: 50 }, (_, i) => row(`old${i}`, `無関係${i}`, null));
    findMany.mockImplementation(async (args: { where: { nameKey?: null } }) =>
      args.where.nameKey === null ? legacy : [row("hit", "パーク第１", "パ-ク第1")],
    );
    const res = await call("name=" + encodeURIComponent("パーク第１"));
    const data = (await res.json()).data as { id: string }[];
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(data.map((x) => x.id)).toEqual(["hit"]);
  });

  it("★部分一致の棟が50件あっても、同じ名前(比較キー一致)の棟は別の枠で必ず読み、先頭に出る", async () => {
    const row = (id: string, name: string, nameKey: string | null, created: string) => ({
      id, name, address: "東京都港区六本木1丁目1", nameKey, areaKey: null,
      createdAt: new Date(created), _count: { properties: 1 },
    });
    const partials = Array.from({ length: 50 }, (_, i) => row(`p${i}`, `パーク第１別館${i}`, `パ-ク第1別館${i}`, "2020-01-01"));
    const exact = row("exact", "パーク第一", "パ-ク第1", "2026-05-01");
    findMany.mockImplementation(async (args: { where: { nameKey?: unknown; OR?: unknown } }) => {
      if (args.where.nameKey === null) return [];
      if (args.where.OR) return partials; // 古い部分一致で枠が埋まり、同じ名前の棟は入らない
      if (args.where.nameKey === "パ-ク第1") return [exact];
      return [];
    });
    const res = await call("name=" + encodeURIComponent("パーク第１"));
    const data = (await res.json()).data as { id: string }[];
    expect(findMany.mock.calls.some((c) => c[0].where.nameKey === "パ-ク第1" && c[0].take === 50)).toBe(true);
    expect(data[0].id).toBe("exact");
    expect(data.filter((x) => x.id === "exact")).toHaveLength(1);
  });

  it("★番地つきの住所(address)は読まず、町丁目(area)だけで同じ丁目を判断する", async () => {
    const rowA = {
      id: "a", name: "パーク第一", address: "東京都港区六本木1丁目1", nameKey: "パ-ク第1",
      areaKey: "東京都港区六本木1丁目", createdAt: new Date("2026-01-01"), _count: { properties: 1 },
    };
    findMany.mockImplementation(async (args: { where: { nameKey?: unknown } }) =>
      args.where.nameKey === "パ-ク第1" ? [rowA] : [],
    );
    const viaAddress = await call(
      "name=" + encodeURIComponent("パーク第１") + "&address=" + encodeURIComponent("東京都港区六本木1丁目1-2"),
    );
    const a = (await viaAddress.json()).data as { id: string; sameArea: boolean }[];
    expect(a[0].sameArea).toBe(false); // address は無視される
    const viaArea = await call(
      "name=" + encodeURIComponent("パーク第１") + "&area=" + encodeURIComponent("東京都港区六本木1丁目"),
    );
    const b = (await viaArea.json()).data as { id: string; sameArea: boolean }[];
    expect(b[0].sameArea).toBe(true);
  });

  it("名前が合わない古い棟は応答から除く(取得後の絞り込み)", async () => {
    findMany.mockResolvedValue([
      {
        id: "x", name: "まったく別の建物", address: "東京都港区六本木1丁目1",
        nameKey: null, areaKey: null, createdAt: new Date("2026-01-01"),
        _count: { properties: 1 },
      },
    ]);
    const res = await call("name=" + encodeURIComponent("パーク第１"));
    expect((await res.json()).data).toEqual([]);
  });
});
