/**
 * 単発の検索 API は、番号が無い/読めない物件を **実サイトへ行かせない**（設計 §4.4）。
 *
 * ⚠一括は同じ理由コードを「除外」「skip」に読み替えるので、止め方は呼び出し側で違う。
 *   共通の入口（buildRegistrySearchRequest）は理由を返すだけにしてある
 *   ＝ここで 422 を投げても一括のジョブ作成は落ちない。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
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
    getApiSession: vi.fn(async () => ({
      id: "user-1",
      email: "a@a",
      name: "A",
      role: "admin",
    })),
    getUserPermissions: vi.fn(async () => [
      { resource: "registry", action: "auto_fetch", granted: true },
      { resource: "property", action: "read", granted: true },
    ]),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e?.message ?? "", code: e?.code ?? "INTERNAL" } },
        { status: e?.status ?? 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
    parseJsonBody: vi.fn(async (req: Request) => req.json()),
  };
});

vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/registry-fetch/search", () => ({
  runRegistrySearch: vi.fn(),
  resolveRegistryCandidate: vi.fn(),
}));
vi.mock("@/lib/registry-fetch/auto-fetch", () => ({
  getRegistryFetchProvider: vi.fn(async () => ({
    name: "mock",
    supportsLocationSearch: true,
    searchCandidates: vi.fn(),
  })),
}));
vi.mock("@/lib/registry-fetch/live-view-store", () => ({
  reportLiveStep: vi.fn(() => 1),
  attachLiveShot: vi.fn(),
  isLiveViewCancelRequested: vi.fn(() => false),
  closeLiveViewCancelWindow: vi.fn(),
  completeLiveView: vi.fn(),
  startLiveView: vi.fn(),
}));

import { runRegistrySearch } from "@/lib/registry-fetch/search";
import { POST } from "../../app/api/properties/[id]/registry/search/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";

function call() {
  const req = new Request(
    `http://localhost/api/properties/${PROPERTY_ID}/registry/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    },
  );
  return POST(req as never, {
    params: Promise.resolve({ id: PROPERTY_ID }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("番号の問題は 422 で止める（実サイトへ行かない）", () => {
  it.each(["missing_identifier", "malformed_identifier"])(
    "%s は 422",
    async (reason) => {
      (runRegistrySearch as Mock).mockResolvedValue({
        searchable: false,
        reason,
      });
      const res = await call();
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("REGISTRY_SEARCH_IDENTIFIER_INVALID");
    },
  );

  it("⚠文言は「何を直せばよいか」が分かるものにする", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: false,
      reason: "missing_identifier",
    });
    const body = await (await call()).json();
    expect(body.error.message).toContain("地番");
  });

  it("⚠エラー文言に地番の値そのものを載せない（秘匿）", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: false,
      reason: "malformed_identifier",
    });
    const body = await (await call()).json();
    expect(body.error.message).not.toMatch(/\d{2,}/);
  });
});

describe("既存の理由と正常系は今までどおり 200", () => {
  it.each(["has_real_estate_number", "insufficient_location"])(
    "%s は 200（画面が案内を出す）",
    async (reason) => {
      (runRegistrySearch as Mock).mockResolvedValue({
        searchable: false,
        reason,
      });
      const res = await call();
      expect(res.status).toBe(200);
    },
  );

  it("検索できるときは 200", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: true,
      candidates: [],
    });
    const res = await call();
    expect(res.status).toBe(200);
  });
});
