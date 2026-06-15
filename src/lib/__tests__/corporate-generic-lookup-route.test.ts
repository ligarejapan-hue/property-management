/**
 * POST /api/corporate/lookup（汎用・非owner-scoped）ルートテスト。
 *
 * 住所補完 /api/address/lookup/* と同型の server-side proxy:
 * - 認証必須（未ログイン 401）。匿名濫用・NTAキー消費を防ぐ。
 * - 13桁正常で 200・candidates:[record]（found / closed とも record を候補に含める）
 * - ハイフン/全角/空白を正規化して lookup
 * - 0件は 200・candidates:[]（候補なし=空配列）
 * - 入力不正（12/14桁・非文字列・欠落）は 400・lookup 未呼び出し
 * - NOT_CONFIGURED→503 / RATE_LIMITED→429 / 上流系→502
 * - DB/AuditLog に触れない（owner-scoped route と異なり mutation/監査なし＝address-lookup と同型）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "a@a",
      name: "A",
      role: "admin",
    }),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/corporate-lookup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/corporate-lookup")>(
    "@/lib/corporate-lookup",
  );
  return {
    ...actual,
    lookupCorporateNumber: vi.fn(),
  };
});

import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import {
  lookupCorporateNumber,
  CorporateLookupError,
} from "@/lib/corporate-lookup";
import { POST } from "../../app/api/corporate/lookup/route";

// owner-scoped route と同一の認可ゲート（owner:read + 明示 owner_corporate_number）を検証する。
const PERMS_FULL = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
];
const PERMS_NO_OWNER_READ = [
  { resource: "owner_corporate_number", action: "full", granted: true },
];
const PERMS_NO_CORP = [
  { resource: "owner", action: "read", granted: true },
];

const RAW_NUMBER = "1234567890123";
const RAW_NAME = "○○株式会社";
const RAW_ADDRESS = "東京都千代田区丸の内１−１−１";

const RECORD = {
  corporateNumber: RAW_NUMBER,
  name: RAW_NAME,
  furigana: "○○カブシキガイシャ",
  address: RAW_ADDRESS,
  prefectureName: "東京都",
  cityName: "千代田区",
  streetNumber: "丸の内１−１−１",
  postCode: "1000005",
  updateDate: "2025-04-01",
};

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/corporate/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "a@a",
    name: "A",
    role: "admin",
  } as Awaited<ReturnType<typeof getApiSession>>);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(lookupCorporateNumber).mockResolvedValue({
    found: true,
    isClosed: false,
    closeDate: null,
    closeCause: null,
    record: RECORD,
    fetchedAt: "2026-05-22T07:30:00.000Z",
    source: "nta-houjin-bangou-v4",
  });
});

describe("POST /api/corporate/lookup — 正常系", () => {
  it("13桁正常で 200・candidates:[record]", async () => {
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.candidates)).toBe(true);
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].name).toBe(RAW_NAME);
    expect(json.candidates[0].address).toBe(RAW_ADDRESS);
  });

  it("ハイフン混じりを正規化して lookup", async () => {
    await POST(makeRequest({ corporateNumber: "1234-5678-9012-3" }));
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("全角数字を正規化して lookup", async () => {
    await POST(makeRequest({ corporateNumber: "１２３４５６７８９０１２３" }));
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("空白混じりを正規化して lookup", async () => {
    await POST(makeRequest({ corporateNumber: " 1234 5678 9012 3 " }));
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("0件 (found=false) は 200・candidates:[]（候補なし）", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce({
      found: false,
      isClosed: false,
      closeDate: null,
      closeCause: null,
      record: null,
      fetchedAt: "2026-05-22T07:30:00.000Z",
      source: "nta-houjin-bangou-v4",
    });
    const res = await POST(makeRequest({ corporateNumber: "9999999999999" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates).toEqual([]);
  });

  it("廃止法人 (isClosed=true) も record を候補に含める", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce({
      found: true,
      isClosed: true,
      closeDate: "2024-12-31",
      closeCause: "01",
      record: { ...RECORD, name: "廃止モック株式会社" },
      fetchedAt: "2026-05-22T07:30:00.000Z",
      source: "nta-houjin-bangou-v4",
    });
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].name).toBe("廃止モック株式会社");
  });
});

describe("POST /api/corporate/lookup — 異常系", () => {
  it("未認証は 401（getApiSession が throw）", async () => {
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(401);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("owner:read 無しで 403・lookup 未呼び出し（Codex P1: API側バイパス防止）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_NO_OWNER_READ);
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(403);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("owner_corporate_number 権限なしで 403・lookup 未呼び出し（hidden ユーザーのバイパス防止）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_NO_CORP);
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(403);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("12桁は 400・lookup 未呼び出し", async () => {
    const res = await POST(makeRequest({ corporateNumber: "123456789012" }));
    expect(res.status).toBe(400);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("14桁は 400", async () => {
    const res = await POST(makeRequest({ corporateNumber: "12345678901234" }));
    expect(res.status).toBe(400);
  });

  it("非文字列は 400", async () => {
    const res = await POST(makeRequest({ corporateNumber: 1234567890123 }));
    expect(res.status).toBe(400);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("欠落（空 body）は 400", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("NOT_CONFIGURED で 503", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("NOT_CONFIGURED", "未設定"),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_CONFIGURED");
  });

  it("RATE_LIMITED で 429", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("RATE_LIMITED", "429", 429),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(429);
  });

  it("上流 5xx (UPSTREAM_5XX) で 502", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("UPSTREAM_ERROR");
  });

  it("timeout / network / parse は 502", async () => {
    for (const code of ["TIMEOUT", "NETWORK", "PARSE_ERROR"] as const) {
      vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
        new CorporateLookupError(code, code),
      );
      const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
      expect(res.status).toBe(502);
    }
  });

  it("レスポンスに raw/secret を載せない（candidates の許可フィールドのみ）", async () => {
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }));
    const json = await res.json();
    // 返すのは record の許可フィールドのみ。NTA appId 等の env / raw XML は混入しない。
    expect(JSON.stringify(json)).not.toContain("<corporation");
    expect(JSON.stringify(json)).not.toContain("CORPORATE_NUMBER_API");
  });
});
