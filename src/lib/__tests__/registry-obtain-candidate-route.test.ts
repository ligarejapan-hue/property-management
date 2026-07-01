/**
 * PR-2b-3: auto-fetch route の candidateRef 分岐（所在検索の候補を選んで取得）の配線検証。
 * lib（resolveRegistryCandidate / runRegistryAutoFetch）は mock し、route が cond③ の再解決を
 * 経由して override 番号で取得することだけを固定する。権限は実 hasPermission + mock getUserPermissions。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => {
      const t = await r.text();
      return t.trim() === "" ? {} : JSON.parse(t);
    }),
    apiResponse: vi.fn((d: unknown, s = 200) =>
      Response.json(d as Record<string, unknown>, { status: s }),
    ),
    handleApiError: vi.fn((e: unknown) => {
      const x = e as { status?: number; message?: string; code?: string };
      if (typeof x?.status === "number") {
        return Response.json({ error: { message: x.message, code: x.code } }, { status: x.status });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});

vi.mock("@/lib/registry-fetch/auto-fetch", () => ({
  getRegistryFetchProvider: vi.fn(),
  runRegistryAutoFetch: vi.fn(),
}));
vi.mock("@/lib/registry-fetch/search", () => ({
  resolveRegistryCandidate: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { getRegistryFetchProvider, runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";
import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import * as routeModule from "@/app/api/properties/[id]/registry/auto-fetch/route";

const { POST } = routeModule;
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const PERMS_FULL = [
  { resource: "registry", action: "auto_fetch", granted: true },
  { resource: "property", action: "read", granted: true },
];

function callRoute(body: unknown) {
  const req = new Request(
    `http://test/api/properties/${PROP_ID}/registry/auto-fetch`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) },
  ) as never;
  return POST(req, { params: Promise.resolve({ id: PROP_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "admin", email: "u@t", name: "U" });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL);
  (getRegistryFetchProvider as Mock).mockReturnValue({
    name: "mock",
    supportsLocationSearch: true,
    searchCandidates: vi.fn(),
    fetchRegistryPdf: vi.fn(),
  });
  (runRegistryAutoFetch as Mock).mockResolvedValue({ status: "obtained" });
  (resolveRegistryCandidate as Mock).mockResolvedValue({ realEstateNumber: "RESOLVED-REN" });
});

describe("auto-fetch route: candidateRef 分岐（cond③ 再解決の配線）", () => {
  it("candidateRef 指定 → resolveRegistryCandidate 経由で解決した番号で取得", async () => {
    const res = await callRoute({ confirmed: true, candidateRef: "cand-1" });
    expect(res.status).toBe(200);
    expect(resolveRegistryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: PROP_ID, confirmed: true, candidateRef: "cand-1" }),
    );
    expect(runRegistryAutoFetch).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: PROP_ID, confirmed: true, realEstateNumber: "RESOLVED-REN" }),
      expect.anything(),
    );
  });

  it("candidateRef 無し → 従来の物件番号取得（resolve は呼ばない・override 無し）", async () => {
    const res = await callRoute({ confirmed: true });
    expect(res.status).toBe(200);
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    const arg = (runRegistryAutoFetch as Mock).mock.calls[0][0];
    expect(arg.realEstateNumber).toBeUndefined();
  });

  it("candidateRef 空文字 → candidateRef 分岐に入らない（従来取得）", async () => {
    await callRoute({ confirmed: true, candidateRef: "   " });
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    expect(runRegistryAutoFetch).toHaveBeenCalledTimes(1);
  });

  it("再解決で候補が見つからない（resolve が 409）→ 409・取得しない", async () => {
    (resolveRegistryCandidate as Mock).mockRejectedValue(
      Object.assign(new Error("not found"), { status: 409, code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND" }),
    );
    const res = await callRoute({ confirmed: true, candidateRef: "cand-x" });
    expect(res.status).toBe(409);
    expect(runRegistryAutoFetch).not.toHaveBeenCalled();
  });

  it("confirmed:true 無しは 400（candidateRef があっても resolve/取得しない）", async () => {
    const res = await callRoute({ candidateRef: "cand-1" });
    expect(res.status).toBe(400);
    expect(resolveRegistryCandidate).not.toHaveBeenCalled();
    expect(runRegistryAutoFetch).not.toHaveBeenCalled();
  });
});
