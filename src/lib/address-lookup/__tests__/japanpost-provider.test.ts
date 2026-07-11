import { describe, it, expect } from "vitest";
import { JapanPostAddressProvider } from "../japanpost-provider";
import { AddressLookupError } from "../types";

const SECRET = "super-secret-key-DO-NOT-LEAK";
const CLIENT_ID = "client-abc";
const SOURCE_IP = "203.0.113.45"; // TEST-NET（実IPではない）
const BASE = "https://example.test/org/system";

type FetchOpts = {
  tokenStatus?: number;
  tokenBody?: unknown;
  searchStatus?: number;
  searchBody?: unknown;
  searchRaw?: string;
  addresszipStatus?: number;
  addresszipBody?: unknown;
  addresszipRaw?: string;
};

function makeFetch(opts: FetchOpts) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.includes("/token")) {
      return new Response(
        JSON.stringify(
          opts.tokenBody ?? { token: "tok-123", token_type: "Bearer", expires_in: 600 },
        ),
        { status: opts.tokenStatus ?? 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/addresszip")) {
      const raw =
        opts.addresszipRaw !== undefined
          ? opts.addresszipRaw
          : JSON.stringify(opts.addresszipBody ?? { addresses: [] });
      return new Response(raw, {
        status: opts.addresszipStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    // searchcode endpoint（郵便番号/デジタルアドレスコード検索）
    const raw =
      opts.searchRaw !== undefined
        ? opts.searchRaw
        : JSON.stringify(opts.searchBody ?? { count: 0, addresses: [] });
    return new Response(raw, {
      status: opts.searchStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

function makeProvider(opts: FetchOpts) {
  const { fn, calls } = makeFetch(opts);
  const provider = new JapanPostAddressProvider({
    clientId: CLIENT_ID,
    secretKey: SECRET,
    sourceIp: SOURCE_IP,
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

describe("JapanPostAddressProvider.lookupByPostalCode（searchcode）", () => {
  it("成功時に候補へマッピングする", async () => {
    const { provider, calls } = makeProvider({
      searchBody: { count: 1, addresses: [SAMPLE_ADDRESS] },
    });
    const got = await provider.lookupByPostalCode("1000005");
    expect(got).toEqual([
      {
        postalCode: "1000005",
        prefecture: "東京都",
        city: "千代田区",
        town: "丸の内",
        addressLine: "東京都千代田区丸の内",
        source: "japanpost",
      },
    ]);
    // searchcode を使う（addresszip は呼ばない）
    expect(calls.some((c) => c.url.includes("/searchcode/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/addresszip"))).toBe(false);
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

describe("JapanPostAddressProvider.searchByAddress（addresszip）", () => {
  it("POST /api/v2/addresszip を呼ぶ（searchcode は呼ばない）", async () => {
    const { provider, calls } = makeProvider({
      addresszipBody: { addresses: [SAMPLE_ADDRESS] },
    });
    await provider.searchByAddress("東京都千代田区丸の内");
    const azCall = calls.find((c) => c.url.includes("/addresszip"));
    expect(azCall).toBeTruthy();
    expect(azCall?.url).toContain("/api/v2/addresszip");
    expect(azCall?.init?.method).toBe("POST");
    // searchcode は使わない
    expect(calls.some((c) => c.url.includes("/searchcode/"))).toBe(false);
  });

  it("addresszip レスポンスを候補へ正規化する（複数）", async () => {
    const { provider } = makeProvider({
      addresszipBody: {
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

  it("addresses が配列の配列(グループ)でも平坦化して候補化する（addresszip 実形）", async () => {
    // 日本郵便 addresszip は候補を addresses 配下に「配列の配列」(グループ)で返す。
    // グループ内・グループ間の両方を平坦化して個々の候補にする必要がある。
    const { provider } = makeProvider({
      addresszipBody: {
        addresses: [
          [SAMPLE_ADDRESS, { ...SAMPLE_ADDRESS, zip_code: "1000004", town_name: "大手町" }],
          [{ ...SAMPLE_ADDRESS, zip_code: "1000001", town_name: "千代田" }],
        ],
      },
    });
    const got = await provider.searchByAddress("東京都千代田区");
    expect(got).toHaveLength(3);
    expect(got.map((c) => c.postalCode)).toEqual(["1000005", "1000004", "1000001"]);
    expect(got[0].addressLine).toBe("東京都千代田区丸の内");
    expect(got.every((c) => c.source === "japanpost")).toBe(true);
  });

  it("想定外shape: 配列/primitive 混在でも壊れた候補を作らず正当なオブジェクトのみ候補化する", async () => {
    // Array.isArray(addresses) だけで RawAddress[] と見なさない。
    // 内側配列・primitive・null は候補化しない（空 addressLine の壊れた候補を出さない）。
    const { provider } = makeProvider({
      addresszipBody: {
        addresses: ["foo", 123, null, [SAMPLE_ADDRESS], SAMPLE_ADDRESS],
      },
    });
    const got = await provider.searchByAddress("東京都千代田区");
    expect(got).toHaveLength(1);
    expect(got[0].postalCode).toBe("1000005");
    expect(got.every((c) => c.addressLine.length > 0)).toBe(true);
  });

  it("想定外shape: 配列の配列だが中身が非オブジェクトなら [](壊れた候補なし)", async () => {
    const { provider } = makeProvider({
      addresszipBody: { addresses: [["x", "y"], ["z"]] },
    });
    expect(await provider.searchByAddress("東京都")).toEqual([]);
  });

  it("候補なしは [] を返す", async () => {
    const { provider } = makeProvider({ addresszipBody: { addresses: [] } });
    expect(await provider.searchByAddress("該当なし町")).toEqual([]);
  });
});

describe("JapanPostAddressProvider — token に x-forwarded-for(送信元IP)を付与", () => {
  it("token request に x-forwarded-for: source IP を含める", async () => {
    const { provider, calls } = makeProvider({ searchBody: { addresses: [] } });
    await provider.lookupByPostalCode("1000005");
    const tokenCall = calls.find((c) => c.url.includes("/token"));
    const headers = tokenCall?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-forwarded-for"]).toBe(SOURCE_IP);
  });

  it("検索リクエストには Bearer token のみ（secret/source IP を生で送らない）", async () => {
    const { provider, calls } = makeProvider({ addresszipBody: { addresses: [] } });
    await provider.searchByAddress("東京都");
    const azCall = calls.find((c) => c.url.includes("/addresszip"));
    const headers = azCall?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok-123");
    const serialized = JSON.stringify(azCall?.init ?? {});
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SOURCE_IP);
  });
});

describe("JapanPostAddressProvider — エラー分類", () => {
  it("検索が 500 なら UPSTREAM_5XX", async () => {
    const { provider } = makeProvider({ searchStatus: 500, searchRaw: "upstream boom" });
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
      code: "UPSTREAM_5XX",
    });
  });

  it("addresszip が 500 なら UPSTREAM_5XX", async () => {
    const { provider } = makeProvider({ addresszipStatus: 500, addresszipRaw: "boom" });
    await expect(provider.searchByAddress("東京都")).rejects.toMatchObject({
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
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
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

describe("JapanPostAddressProvider — 404(該当なし)は候補なし [] を返す", () => {
  it("searchcode が 404 なら [](UPSTREAM_4XX/外部失敗にしない)", async () => {
    const { provider } = makeProvider({ searchStatus: 404, searchRaw: "not found" });
    expect(await provider.lookupByPostalCode("1000005")).toEqual([]);
  });

  it("addresszip が 404 なら [](外部失敗にしない)", async () => {
    const { provider } = makeProvider({ addresszipStatus: 404, addresszipRaw: "not found" });
    expect(await provider.searchByAddress("該当なし町")).toEqual([]);
  });

  it("token endpoint の 404 は候補なし扱いにせず error を投げる", async () => {
    const { provider } = makeProvider({ tokenStatus: 404 });
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
      code: "UPSTREAM_4XX",
    });
  });

  it("404 以外の 4xx(403)は AUTH_FAILED を維持（候補なしにしない）", async () => {
    const { provider } = makeProvider({ searchStatus: 403, searchRaw: "forbidden" });
    await expect(provider.lookupByPostalCode("1000005")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });
});

describe("JapanPostAddressProvider — zip_code の string/number 両対応(P2)", () => {
  it("zip_code が string でも postalCode を保持", async () => {
    const { provider } = makeProvider({
      searchBody: { addresses: [{ ...SAMPLE_ADDRESS, zip_code: "1000005" }] },
    });
    const got = await provider.lookupByPostalCode("1000005");
    expect(got[0].postalCode).toBe("1000005");
  });

  it("zip_code が number でも padStart(7) で postalCode を保持", async () => {
    const { provider } = makeProvider({
      searchBody: { addresses: [{ ...SAMPLE_ADDRESS, zip_code: 1000005 }] },
    });
    const got = await provider.lookupByPostalCode("1000005");
    expect(got[0].postalCode).toBe("1000005");
  });

  it("先頭0系: number 100492 を 0100492 として保持", async () => {
    const { provider } = makeProvider({
      addresszipBody: {
        addresses: [{ ...SAMPLE_ADDRESS, zip_code: 100492, pref_name: "北海道", city_name: "札幌市東区", town_name: "" }],
      },
    });
    const got = await provider.searchByAddress("北海道札幌市東区");
    expect(got[0].postalCode).toBe("0100492");
  });

  it("不正な zip_code（7桁化できない）は postalCode を入れない", async () => {
    const { provider } = makeProvider({
      searchBody: { addresses: [{ ...SAMPLE_ADDRESS, zip_code: "abc" }] },
    });
    const got = await provider.lookupByPostalCode("1000005");
    expect(got[0].postalCode).toBeUndefined();
    expect(got[0].addressLine.length).toBeGreaterThan(0); // 住所自体は返る
  });
});

describe("JapanPostAddressProvider — secret / source IP 非漏洩", () => {
  it("token 失敗時の例外 message に secret/clientId/source IP を含めない", async () => {
    const { provider } = makeProvider({ tokenStatus: 403 });
    try {
      await provider.lookupByPostalCode("1000005");
      throw new Error("should have thrown");
    } catch (e) {
      const text = `${(e as Error).name}:${(e as Error).message}:${(e as Error).stack ?? ""}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(CLIENT_ID);
      expect(text).not.toContain(SOURCE_IP);
    }
  });

  it("成功候補に secret/token/source IP/生レスポンスを含めない", async () => {
    const { provider } = makeProvider({ searchBody: { addresses: [SAMPLE_ADDRESS] } });
    const json = JSON.stringify(await provider.lookupByPostalCode("1000005"));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("tok-123");
    expect(json).not.toContain(SOURCE_IP);
    expect(json).not.toContain("dgacode");
    expect(json).not.toContain("pref_code");
  });
});
