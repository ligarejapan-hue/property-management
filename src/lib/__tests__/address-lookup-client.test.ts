/**
 * fetchAddressCandidates(住所→候補)は住所 PII を URL に載せず POST body で送る。
 * （住所全文が browser history / reverse-proxy / server access log に残らないよう Codex P2 対応。）
 * USE_MOCK=false（実 API パス）で global fetch を捕捉し、呼び出し URL/method/body を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("fetchAddressCandidates は住所を POST body で送る（URL に住所を載せない）", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", ""); // 実 API パス（USE_MOCK=false）を通す
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POST /api/address/lookup/search を呼び、URL に住所を含めず body に { address } を入れる", async () => {
    const address = "東京都千代田区丸の内1-1-X番地";
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchAddressCandidates } = await import("../api-client");
    const res = await fetchAddressCandidates(address);

    expect(res).toEqual({ candidates: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // URL に住所文字列・query を含めない
    expect(url).toBe("/api/address/lookup/search");
    expect(url).not.toContain("address=");
    expect(url).not.toContain(address);
    // POST body に { address }
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ address });
  });
});
