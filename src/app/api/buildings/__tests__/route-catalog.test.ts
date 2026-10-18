import { describe, it, expect, vi } from "vitest";
const findManyBuildings = vi.fn(async () => []);
const findManyCatalog = vi.fn(async () => [{ id: "c1", name: "プラウド青砥" }]);
vi.mock("@/lib/prisma", () => ({ default: { building: { findMany: (...a: unknown[]) => findManyBuildings(...(a as [])) }, mansionCatalog: { findMany: (...a: unknown[]) => findManyCatalog(...(a as [])) } } }));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error { constructor(public status: number, message: string, public code = "ERROR") { super(message); } }
  return {
    ApiError: MockApiError,
    getApiSession: async () => ({ id: "u1", role: "admin" }),
    getUserPermissions: async () => [],
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => new Response(String(e), { status: 500 }),
  };
});
import { GET } from "../route";
const req = (q: string) => ({ nextUrl: new URL(`http://localhost/api/buildings${q}`) }) as never;

describe("GET /api/buildings の名簿の段", () => {
  it("2文字以上で探したときだけ、棟になっていない名簿を20件まで返す", async () => {
    const body = await (await GET(req("?keyword=プラウド"))).json();
    expect(body.catalog).toEqual([{ id: "c1", name: "プラウド青砥" }]);
    const args = (findManyCatalog.mock.calls[0] as unknown[])[0] as { where: { building: unknown }; take: number };
    expect(args.where.building).toEqual({ is: null });
    expect(args.take).toBe(20);
  });
  it("何も入れないときは名簿を引かない", async () => {
    findManyCatalog.mockClear();
    const body = await (await GET(req(""))).json();
    expect(body.catalog).toEqual([]);
    expect(findManyCatalog).not.toHaveBeenCalled();
  });
});
