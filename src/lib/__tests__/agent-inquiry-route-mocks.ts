/**
 * 反響の受付の route テストで共通に使う mock の部品(next/server・api-helpers)。
 * vi.mock はファイル先頭へ巻き上げられるため、各テストでは工場関数の中で動的 import する:
 *   vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
 *   vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
 */
import { vi } from "vitest";

export function nextServerMock() {
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextResponse: MockNextResponse };
}

export function apiHelpersMock() {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : (e as { name?: string })?.name === "ZodError"
          ? Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 })
          : Response.json({ error: { code: "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: 500 }),
    ),
  };
}

export const jsonRequest = (method: string, body: unknown) =>
  new Request("http://x/api", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
