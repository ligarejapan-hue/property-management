import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReinfilibProvider } from "../reinfolib-provider";
import { isProviderOutage } from "../auto-fetch";

vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("../fetch-investigation", () => ({ runAutoInvestigation: vi.fn() }));

const query = { propertyId: "p1", address: "東京都千代田区霞が関1-1", lotNumber: null, gpsLat: null, gpsLng: null };

/** 国土地理院の住所検索だけを差し替え、ほかの問い合わせ(タイル)は空の結果を返す。 */
function stubFetch(geocode: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("msearch.gsi.go.jp")) return geocode();
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 });
    }),
  );
}

async function providerFailure(): Promise<string> {
  const p = new ReinfilibProvider();
  try {
    await p.fetch(query);
    return "(成功した)";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("住所検索サービスの障害と、見つからない住所を分ける(@codex #723 P1)", () => {
  beforeEach(() => {
    process.env.REINFOLIB_API_KEY = "test-stub";
  });
  afterEach(() => {
    delete process.env.REINFOLIB_API_KEY;
    vi.unstubAllGlobals();
  });

  it("住所検索が0件=その物件の問題(見回りは止まらない)", async () => {
    stubFetch(async () => new Response("[]", { status: 200 }));
    const msg = await providerFailure();
    expect(msg.startsWith("住所のジオコーディングに失敗しました")).toBe(true);
    expect(isProviderOutage({ providers: [{ name: "reinfolib", status: "failed", error: msg }] })).toBe(false);
  });

  it("住所検索が HTTP エラー=サービスの障害(見回りは休む)", async () => {
    stubFetch(async () => new Response("unavailable", { status: 503 }));
    const msg = await providerFailure();
    expect(msg.startsWith("住所のジオコーディングに失敗しました")).toBe(false);
    expect(isProviderOutage({ providers: [{ name: "reinfolib", status: "failed", error: msg }] })).toBe(true);
  });

  it("住所検索がつながらない・時間切れ=サービスの障害(見回りは休む)", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const msg = await providerFailure();
    expect(isProviderOutage({ providers: [{ name: "reinfolib", status: "failed", error: msg }] })).toBe(true);
  });

  it("座標がある物件は、住所検索が落ちていても取れる", async () => {
    stubFetch(async () => new Response("unavailable", { status: 503 }));
    const p = new ReinfilibProvider();
    const res = await p.fetch({ ...query, gpsLat: 35.6, gpsLng: 139.7 });
    expect(res.meta?.geocodedLat).toBe(35.6);
  });
});
