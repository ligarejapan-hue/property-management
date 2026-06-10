/**
 * GET /api/address/lookup/postal-code and /search ルートテスト。
 *
 * 認証必須・入力検証(400)・未設定(503)・外部失敗(502)・候補整形(secret 非混入)を検証する。
 * 外部 API は lib(@/lib/address-lookup)を mock して route の責務のみをテストする。
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
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

vi.mock("@/lib/address-lookup", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/address-lookup")>("@/lib/address-lookup");
  return {
    ...actual,
    lookupAddressByPostalCode: vi.fn(),
    searchAddressByText: vi.fn(),
  };
});

import { getApiSession } from "@/lib/api-helpers";
import {
  lookupAddressByPostalCode,
  searchAddressByText,
  AddressLookupError,
} from "@/lib/address-lookup";
import { GET as postalGET } from "../../app/api/address/lookup/postal-code/route";
import { POST as searchPOST } from "../../app/api/address/lookup/search/route";

const CANDIDATE = {
  postalCode: "1000005",
  prefecture: "東京都",
  city: "千代田区",
  town: "丸の内",
  addressLine: "東京都千代田区丸の内",
  source: "japanpost",
};

function postalReq(zip: string) {
  return new Request(
    `http://localhost/api/address/lookup/postal-code?zip=${encodeURIComponent(zip)}`,
  ) as unknown as import("next/server").NextRequest;
}
function searchReq(address: string) {
  return new Request("http://localhost/api/address/lookup/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  }) as unknown as import("next/server").NextRequest;
}
function searchRawReq(rawBody: string) {
  return new Request("http://localhost/api/address/lookup/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "a@a",
    name: "A",
    role: "admin",
  });
  vi.mocked(lookupAddressByPostalCode).mockResolvedValue([CANDIDATE]);
  vi.mocked(searchAddressByText).mockResolvedValue([CANDIDATE]);
});

describe("GET /api/address/lookup/postal-code", () => {
  it("成功時に candidates を返す", async () => {
    const res = await postalGET(postalReq("100-0005"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates).toEqual([CANDIDATE]);
    // 正規化された 7 桁で lib を呼ぶ
    expect(vi.mocked(lookupAddressByPostalCode)).toHaveBeenCalledWith("1000005");
  });

  it("候補なしは candidates=[] を返す", async () => {
    vi.mocked(lookupAddressByPostalCode).mockResolvedValueOnce([]);
    const res = await postalGET(postalReq("1000005"));
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([]);
  });

  it("7桁でない郵便番号は 400（lib を呼ばない）", async () => {
    const res = await postalGET(postalReq("123"));
    expect(res.status).toBe(400);
    expect(vi.mocked(lookupAddressByPostalCode)).not.toHaveBeenCalled();
  });

  it("zip 未指定は 400", async () => {
    const res = await postalGET(
      new Request("http://localhost/api/address/lookup/postal-code") as unknown as import("next/server").NextRequest,
    );
    expect(res.status).toBe(400);
  });

  it("未設定(NOT_CONFIGURED)は 503", async () => {
    vi.mocked(lookupAddressByPostalCode).mockRejectedValueOnce(
      new AddressLookupError("NOT_CONFIGURED", "未設定"),
    );
    const res = await postalGET(postalReq("1000005"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("NOT_CONFIGURED");
  });

  it("外部失敗(UPSTREAM_5XX)は 502", async () => {
    vi.mocked(lookupAddressByPostalCode).mockRejectedValueOnce(
      new AddressLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    const res = await postalGET(postalReq("1000005"));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("UPSTREAM_ERROR");
  });

  it("外部失敗(TIMEOUT/RATE_LIMITED/AUTH_FAILED)も 502", async () => {
    for (const code of ["TIMEOUT", "RATE_LIMITED", "AUTH_FAILED"] as const) {
      vi.mocked(lookupAddressByPostalCode).mockRejectedValueOnce(
        new AddressLookupError(code, code),
      );
      const res = await postalGET(postalReq("1000005"));
      expect(res.status).toBe(502);
    }
  });

  it("未認証は 401（lib を呼ばない）", async () => {
    const { ApiError } = await import("@/lib/api-helpers");
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await postalGET(postalReq("1000005"));
    expect(res.status).toBe(401);
    expect(vi.mocked(lookupAddressByPostalCode)).not.toHaveBeenCalled();
  });

  it("応答に APIキー/トークン/raw secret を含めない", async () => {
    const res = await postalGET(postalReq("1000005"));
    const json = await res.json();
    const text = JSON.stringify(json);
    expect(text).not.toContain("ADDRESS_LOOKUP_API_KEY");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
    // 返るのは candidates キーのみ
    expect(Object.keys(json)).toEqual(["candidates"]);
  });
});

describe("POST /api/address/lookup/search", () => {
  it("body の住所で複数候補を返す（route は POST body から address を読む）", async () => {
    vi.mocked(searchAddressByText).mockResolvedValueOnce([
      CANDIDATE,
      { ...CANDIDATE, postalCode: "1000004", town: "大手町", addressLine: "東京都千代田区大手町" },
    ]);
    const res = await searchPOST(searchReq("東京都千代田区"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(vi.mocked(searchAddressByText)).toHaveBeenCalledWith("東京都千代田区");
  });

  it("候補なしは candidates=[] を返す", async () => {
    vi.mocked(searchAddressByText).mockResolvedValueOnce([]);
    const res = await searchPOST(searchReq("該当なし町"));
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([]);
  });

  it("空住所は 400（lib を呼ばない）", async () => {
    const res = await searchPOST(searchReq("   "));
    expect(res.status).toBe(400);
    expect(vi.mocked(searchAddressByText)).not.toHaveBeenCalled();
  });

  it("address 欠落の body は 400（lib を呼ばない）", async () => {
    const req = new Request("http://localhost/api/address/lookup/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as unknown as import("next/server").NextRequest;
    const res = await searchPOST(req);
    expect(res.status).toBe(400);
    expect(vi.mocked(searchAddressByText)).not.toHaveBeenCalled();
  });

  it("不正 JSON body は 400（lib を呼ばない）", async () => {
    const res = await searchPOST(searchRawReq("<<<not json>>>"));
    expect(res.status).toBe(400);
    expect(vi.mocked(searchAddressByText)).not.toHaveBeenCalled();
  });

  it("未認証は 401（lib を呼ばない）", async () => {
    const { ApiError } = await import("@/lib/api-helpers");
    vi.mocked(getApiSession).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await searchPOST(searchReq("東京都"));
    expect(res.status).toBe(401);
    expect(vi.mocked(searchAddressByText)).not.toHaveBeenCalled();
  });

  it("未設定は 503 / 外部失敗は 502", async () => {
    vi.mocked(searchAddressByText).mockRejectedValueOnce(
      new AddressLookupError("NOT_CONFIGURED", "未設定"),
    );
    expect((await searchPOST(searchReq("東京都"))).status).toBe(503);
    vi.mocked(searchAddressByText).mockRejectedValueOnce(
      new AddressLookupError("NETWORK", "net"),
    );
    expect((await searchPOST(searchReq("東京都"))).status).toBe(502);
  });

  it("入力住所を error message / response に出さない", async () => {
    const secretAddress = "東京都港区秘密町9-9-9";
    vi.mocked(searchAddressByText).mockRejectedValueOnce(
      new AddressLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    const res = await searchPOST(searchReq(secretAddress));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(secretAddress);
  });

  it("応答に APIキー/トークン/secret を含めない（candidates キーのみ）", async () => {
    const res = await searchPOST(searchReq("東京都千代田区"));
    const json = await res.json();
    const text = JSON.stringify(json);
    expect(text).not.toContain("ADDRESS_LOOKUP_API_KEY");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
    expect(Object.keys(json)).toEqual(["candidates"]);
  });
});
