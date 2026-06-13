import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCorporateCleanupPreview, applyCorporateCleanup } from "../corporate-cleanup-client";

beforeEach(() => { vi.restoreAllMocks(); });

describe("corporate-cleanup-client", () => {
  it("preview は GET し cleanup を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cleanup: { action: "cleanup" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchCorporateCleanupPreview("o1");
    expect(fetchMock).toHaveBeenCalledWith("/api/owners/o1/corporate-cleanup", expect.objectContaining({ method: "GET" }));
    expect(r.action).toBe("cleanup");
  });

  it("apply は POST し body に version/apply を載せる", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, owner: { id: "o1", version: 3 } }) });
    vi.stubGlobal("fetch", fetchMock);
    const r = await applyCorporateCleanup("o1", { version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/owners/o1/corporate-cleanup");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body).version).toBe(2);
    expect(r.owner.version).toBe(3);
  });

  it("非OK は error.code を投げる", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: "CONFLICT", message: "x" } }) }));
    await expect(applyCorporateCleanup("o1", { version: 1, apply: { name: true, address: false, note: false, corporateNumber: false } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });
});
