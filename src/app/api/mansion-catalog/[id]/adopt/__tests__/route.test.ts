import { describe, it, expect, vi, beforeEach } from "vitest";
const adoptCatalogBuilding = vi.fn();
const getApiSession = vi.fn(async () => ({ id: "u1", role: "admin" }));
const getUserPermissions = vi.fn(async () => [{ resource: "property", action: "write" }]);
vi.mock("@/lib/mansion-catalog/adopt", () => ({ adoptCatalogBuilding: (...a: unknown[]) => adoptCatalogBuilding(...a) }));
vi.mock("@/lib/prisma", () => ({ default: { $transaction: (fn: (tx: unknown) => unknown) => fn({}) } }));
vi.mock("@/lib/permissions", () => ({
  hasPermission: (perms: { resource: string; action: string }[], r: string, a: string) => perms.some((p) => p.resource === r && p.action === a),
}));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error { constructor(public status: number, message: string, public code = "ERROR") { super(message); } }
  return {
    ApiError: MockApiError,
    getApiSession: () => getApiSession(),
    getUserPermissions: () => getUserPermissions(),
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status ?? 500 });
    },
  };
});
import { POST } from "../route";

const ID = "0b5e8f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const call = (id = ID) => POST(new Request(`http://localhost/api/mansion-catalog/${id}/adopt`, { method: "POST" }) as never, { params: Promise.resolve({ id }) });
beforeEach(() => adoptCatalogBuilding.mockReset());

describe("POST /api/mansion-catalog/:id/adopt", () => {
  it("棟の id を返す", async () => {
    adoptCatalogBuilding.mockResolvedValue({ kind: "created", building: { id: "b1", name: "a" } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buildingId: "b1", kind: "created" });
    expect(adoptCatalogBuilding).toHaveBeenCalledWith({}, ID, "u1");
  });
  it("書き込めない人は 403(DB を触らない)", async () => {
    getUserPermissions.mockResolvedValueOnce([{ resource: "property", action: "read" }]);
    expect((await call()).status).toBe(403);
    expect(adoptCatalogBuilding).not.toHaveBeenCalled();
  });
  it("★id の形が違えば DB を触らず 404(uuid でない値で DB がエラーにならない)", async () => {
    expect((await call("abc")).status).toBe(404);
    expect(adoptCatalogBuilding).not.toHaveBeenCalled();
  });
  it("無ければ 404・同じ名前の棟が複数なら 409", async () => {
    adoptCatalogBuilding.mockResolvedValueOnce({ kind: "not_found" });
    expect((await call()).status).toBe(404);
    adoptCatalogBuilding.mockResolvedValueOnce({ kind: "ambiguous" });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CATALOG_AMBIGUOUS");
  });
});
