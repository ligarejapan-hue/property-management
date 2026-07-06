/**
 * api-client の convertPinToProperty / listCandidatePins は実 API パス(USE_MOCK=false)で
 * 正しいエンドポイント・メソッド・body/クエリを組み立てる。既存 address-lookup-client.test.ts と
 * 同じ流儀(resetModules + stubEnv + 動的 import + global fetch 捕捉)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("api-client: convertPinToProperty / listCandidatePins", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", ""); // 実 API パス(USE_MOCK=false)
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("convertPinToProperty は変換エンドポイントへ POST する", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "p1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { convertPinToProperty } = await import("../api-client");
    const res = await convertPinToProperty("pin-9", { propertyType: "land", address: "A" });

    expect(res).toEqual({ id: "p1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/field-survey/pins/pin-9/convert-to-property");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ propertyType: "land", address: "A" });
  });

  it("listCandidatePins は座標なし専用エンドポイントを叩く", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { listCandidatePins } = await import("../api-client");
    const r = await listCandidatePins();

    expect(r).toEqual({ data: [] });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/field-survey/pins/candidates");
    expect(String(url)).not.toContain("view=map");
  });
});
