/**
 * 国税庁 法人番号 Web-API (NtaProvider) 単体テスト。
 *
 * - 正常 XML を parse する（found / closed）
 * - 0件 (count=0) → found=false
 * - 廃止法人 → isClosed=true
 * - timeout → CorporateLookupError(TIMEOUT)
 * - 5xx → UPSTREAM_5XX
 * - 4xx → UPSTREAM_4XX
 * - 429 → RATE_LIMITED
 * - 不正 XML (name 欠落) → PARSE_ERROR
 * - レスポンスに raw XML をそのまま含めて返さない（戻り値型に xml フィールドが存在しない）
 */
import { describe, it, expect, vi } from "vitest";
import { NtaProvider } from "../nta-provider";
import { CorporateLookupError } from "../types";

const APP_ID = "test-app-id";

// undefined → defaults, null → explicit empty (`<tag/>`)
function makeXml(opts: {
  count?: number;
  name?: string | null;
  number?: string;
  furigana?: string | null;
  prefecture?: string | null;
  city?: string | null;
  street?: string | null;
  postCode?: string | null;
  updateDate?: string | null;
  closeDate?: string | null;
  closeCause?: string | null;
}) {
  const count = opts.count ?? 1;
  if (count === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<corporations>
  <lastUpdateDate>2025-04-01</lastUpdateDate>
  <count>0</count>
  <divideNumber>1</divideNumber>
  <divideSize>1</divideSize>
</corporations>`;
  }
  const tag = (n: string, v: string | null | undefined) =>
    v == null ? `<${n}/>` : `<${n}>${v}</${n}>`;
  const pick = <T,>(v: T | undefined, def: T): T => (v === undefined ? def : v);
  return `<?xml version="1.0" encoding="UTF-8"?>
<corporations>
  <lastUpdateDate>2025-04-01</lastUpdateDate>
  <count>1</count>
  <divideNumber>1</divideNumber>
  <divideSize>1</divideSize>
  <corporation>
    <sequenceNumber>1</sequenceNumber>
    ${tag("corporateNumber", pick(opts.number, "1234567890123"))}
    ${tag("name", pick(opts.name, "○○株式会社"))}
    ${tag("furigana", pick(opts.furigana, "○○カブシキガイシャ"))}
    ${tag("prefectureName", pick(opts.prefecture, "東京都"))}
    ${tag("cityName", pick(opts.city, "千代田区"))}
    ${tag("streetNumber", pick(opts.street, "丸の内１−１−１"))}
    ${tag("postCode", pick(opts.postCode, "1000005"))}
    ${tag("updateDate", pick(opts.updateDate, "2025-04-01"))}
    ${tag("closeDate", pick(opts.closeDate, null))}
    ${tag("closeCause", pick(opts.closeCause, null))}
  </corporation>
</corporations>`;
}

function makeFetch(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "Content-Type": "text/xml" } })) as unknown as typeof fetch;
}

describe("NtaProvider — 正常系", () => {
  it("found 法人 XML を parse できる", async () => {
    const xml = makeXml({});
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    const r = await provider.lookup("1234567890123");
    expect(r.found).toBe(true);
    expect(r.isClosed).toBe(false);
    expect(r.record).not.toBeNull();
    expect(r.record!.name).toBe("○○株式会社");
    expect(r.record!.furigana).toBe("○○カブシキガイシャ");
    expect(r.record!.address).toBe("東京都千代田区丸の内１−１−１");
    expect(r.record!.postCode).toBe("1000005");
    expect(r.record!.updateDate).toBe("2025-04-01");
    expect(r.source).toBe("nta-houjin-bangou-v4");
  });

  it("count=0 のレスポンスで found=false", async () => {
    const xml = makeXml({ count: 0 });
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    const r = await provider.lookup("9999999999999");
    expect(r.found).toBe(false);
    expect(r.record).toBeNull();
  });

  it("廃止法人 (closeDate あり) は isClosed=true", async () => {
    const xml = makeXml({ closeDate: "2024-12-31", closeCause: "01" });
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    const r = await provider.lookup("8888888888888");
    expect(r.found).toBe(true);
    expect(r.isClosed).toBe(true);
    expect(r.closeDate).toBe("2024-12-31");
    expect(r.closeCause).toBe("01");
  });

  it("XML エンティティ (&amp;) を decode できる", async () => {
    const xml = makeXml({ name: "A&amp;B 株式会社" });
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    const r = await provider.lookup("1234567890123");
    expect(r.record!.name).toBe("A&B 株式会社");
  });

  it("postCode が 7桁数字でなければ null にする", async () => {
    const xml = makeXml({ postCode: "100" });
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    const r = await provider.lookup("1234567890123");
    expect(r.record!.postCode).toBeNull();
  });

  it("レスポンス型に raw XML フィールドを含まない", async () => {
    const xml = makeXml({});
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    const r = await provider.lookup("1234567890123");
    expect(JSON.stringify(r)).not.toContain("<corporations>");
    expect(JSON.stringify(r)).not.toContain("<corporation>");
    expect("xml" in r).toBe(false);
    expect("rawBody" in r).toBe(false);
  });
});

describe("NtaProvider — エラー系", () => {
  it("HTTP 500 → UPSTREAM_5XX", async () => {
    const provider = new NtaProvider({
      appId: APP_ID,
      fetchImpl: makeFetch(500, "<error/>"),
    });
    await expect(provider.lookup("1234567890123")).rejects.toMatchObject({
      code: "UPSTREAM_5XX",
    });
  });

  it("HTTP 400 → UPSTREAM_4XX", async () => {
    const provider = new NtaProvider({
      appId: APP_ID,
      fetchImpl: makeFetch(400, "<error/>"),
    });
    await expect(provider.lookup("1234567890123")).rejects.toMatchObject({
      code: "UPSTREAM_4XX",
    });
  });

  it("HTTP 429 → RATE_LIMITED", async () => {
    const provider = new NtaProvider({
      appId: APP_ID,
      fetchImpl: makeFetch(429, "<error/>"),
    });
    await expect(provider.lookup("1234567890123")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("timeout (AbortError) → TIMEOUT", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl });
    await expect(provider.lookup("1234567890123")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("通信エラー → NETWORK", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl });
    await expect(provider.lookup("1234567890123")).rejects.toMatchObject({
      code: "NETWORK",
    });
  });

  it("name 欠落で PARSE_ERROR", async () => {
    const xml = makeXml({ name: null });
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl: makeFetch(200, xml) });
    await expect(provider.lookup("1234567890123")).rejects.toBeInstanceOf(
      CorporateLookupError,
    );
    await expect(provider.lookup("1234567890123")).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });
});

describe("NtaProvider — リクエスト URL", () => {
  it("query に id / number / type=12 / history=0 を含む", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return new Response(makeXml({}), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new NtaProvider({ appId: APP_ID, fetchImpl });
    await provider.lookup("1234567890123");
    expect(capturedUrl).toContain("id=test-app-id");
    expect(capturedUrl).toContain("number=1234567890123");
    expect(capturedUrl).toContain("type=12");
    expect(capturedUrl).toContain("history=0");
  });
});
