import { describe, it, expect } from "vitest";
import { JapanPostAddressProvider } from "../japanpost-provider";
import { AddressLookupError } from "../types";

const SECRET = "super-secret-key-DO-NOT-LEAK";
const CLIENT_ID = "client-abc";
const BASE = "https://example.test/org/system";

type FetchOpts = {
  tokenStatus?: number;
  tokenBody?: unknown;
  searchStatus?: number;
  searchBody?: unknown;
  searchRaw?: string; // override raw text (for parse-error test)
};

function makeFetch(opts: FetchOpts) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.includes("/token")) {
      return new Response(
        JSON.stringify(opts.tokenBody ?? { token: "tok-123", token_type: "Bearer", expires_in: 600 }),
        { status: opts.tokenStatus ?? 200, headers: { "content-type": "application/json" } },
      );
    }
    // searchcode endpoint
    const status = opts.searchStatus ?? 200;
    const raw =
      opts.searchRaw !== undefined
        ? opts.searchRaw
        : JSON.stringify(opts.searchBody ?? { count: 0, addresses: [] });
    return new Response(raw, { status, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

function makeProvider(opts: FetchOpts) {
  const { fn, calls } = makeFetch(opts);
  const provider = new JapanPostAddressProvider({
    clientId: CLIENT_ID,
    secretKey: SECRET,
    baseUrl: BASE,
    fetchFn: fn as unknown as typeof fetch,
  });
  return { provider, calls };
}

const SAMPLE_ADDRESS = {
  dgacode: "A7E2FK2X9",
  zip_code: "1000005",
  pref_code: "13",
  pref_name: "東京都",
  city_code: "13101",
  city_name: "千代田区",
  town_name: "丸の内",
};

describe("JapanPostAddressProvider.lookupByPostalCode", () => {
  it("成功時に候補へマッピングする", async () => {
    const { provider } = makeProvider({ searchBody: { count: 1, addresses: [SAMPLE_ADDRESS] } });
    const got = await provider.lookupByPostalCode("1000005");
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      postalCode: "1000005",
      prefecture: "東京都",
      city: "千代田区",
      town: "丸の内",
      addressLine: "東京都千代田区丸の内",
      source: "japanpost",
    });
  });

  it("候補なしは [] を返す", async () => {
    const { provider } = makeProvider({ searchBody: { count: 0, addresses: [] } });
    expect(await provider.lookupByPostalCode("0000000")).toEqual([]);
  });

  it("name は japanpost", () => {
    const { provider } = makeProvider({});
    expect(provider.name).toBe("japanpost");
  });
});

describe("JapanPostAddressProvider.searchByAddress", () => {
  it("複数候補を返す", async () => {
    const { provider } = makeProvider({
      searchBody: {
        count: 2,
        addresses: [
          SAMPLE_ADDRESS,
          { ...SAMPLE_ADDRESS, zip_code: "1000004", town_name: "大手町" },
        ],
      },
    });
    const got = await provider.searchByAddress("東京都千代田区");
    expect(got).toHaveLength(2);
    expect(got.map((c) => c.postalCode)).toEqual(["1000005", "1000004"]);
    expect(got.every((c) => c.source === "japanpost")).toBe(true);
  });
});

describe("JapanPostAddressProvider — エラー分類", () => {
  it("検索が 500 なら UPSTREAM_5XX", async () => {
    const { provider } = makeProvider({ searchStatus: 500, searchRaw: "upstream boom" });
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
      code: "UPSTREAM_5XX",
    });
  });

  it("token が 401 なら AUTH_FAILED", async () => {
    const { provider } = makeProvider({ tokenStatus: 401, tokenBody: { error: "invalid_client" } });
    await expect(provider.lookupByPostalCode("1000005")).rejects.toBeInstanceOf(AddressLookupError);
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("検索が 429 なら RATE_LIMITED", async () => {
    const { provider } = makeProvider({ searchStatus: 429, searchRaw: "rate" });
    await expect(provider.searchByAddress("東京")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("不正 JSON は PARSE_ERROR", async () => {
    const { provider } = makeProvider({ searchRaw: "<<<not json>>>" });
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });
});

describe("JapanPostAddressProvider — secret 非漏洩", () => {
  it("token 失敗時の例外 message に secret/clientId を含めない", async () => {
    const { provider } = makeProvider({ tokenStatus: 403, searchRaw: "x" });
    try {
      await provider.lookupByPostalCode("1000005");
      throw new Error("should have thrown");
    } catch (e) {
      const text = `${(e as Error).name}:${(e as Error).message}:${(e as Error).stack ?? ""}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(CLIENT_ID);
    }
  });

  it("成功候補に secret/token/生レスポンスを含めない", async () => {
    const { provider } = makeProvider({ searchBody: { count: 1, addresses: [SAMPLE_ADDRESS] } });
    const got = await provider.lookupByPostalCode("1000005");
    const json = JSON.stringify(got);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("tok-123");
    expect(json).not.toContain("dgacode");
    expect(json).not.toContain("pref_code");
  });

  it("Authorization ヘッダには Bearer token を使い secret を生で送らない", async () => {
    const { provider, calls } = makeProvider({ searchBody: { count: 0, addresses: [] } });
    await provider.lookupByPostalCode("1000005");
    const searchCall = calls.find((c) => c.url.includes("/searchcode/"));
    const auth = (searchCall?.init?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer tok-123");
    // secret はトークン取得 body にのみ使われ、検索リクエストには現れない
    expect(JSON.stringify(searchCall?.init ?? {})).not.toContain(SECRET);
  });
});
