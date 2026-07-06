import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("api-client: registry settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetchRegistrySettings は GET /api/admin/registry-settings", async () => {
    const f = vi.fn(
      async (_u: string, _i?: RequestInit) =>
        new Response(JSON.stringify({ hasLoginId: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", f);
    const { fetchRegistrySettings } = await import("../api-client");
    await fetchRegistrySettings();
    expect(String(f.mock.calls[0]![0])).toContain("/api/admin/registry-settings");
  });

  it("updateRegistrySettings は PUT で body 送信", async () => {
    const f = vi.fn(
      async (_u: string, _i?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", f);
    const { updateRegistrySettings } = await import("../api-client");
    await updateRegistrySettings({ loginId: "u1", password: "p1" });
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ loginId: "u1", password: "p1" });
  });
});
