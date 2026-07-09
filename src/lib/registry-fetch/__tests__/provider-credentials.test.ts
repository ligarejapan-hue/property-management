/**
 * provider の credentials 注入(DB-over-env 配線)。
 * 未注入時は env フォールバック(後方互換)。readiness(browserFactory)は据え置きで、
 * credentials があっても browserFactory が無ければ null(本番 501 休眠は不変)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: {} }));
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
  return { ApiError: MockApiError };
});

import {
  getRegistryFetchProvider,
  isRegistryAutoFetchProviderConfigured,
  __resetRegistryFetchThrottleForTest,
} from "../auto-fetch";
import { OfficialRegistryProvider } from "../official-provider";

const ENV_KEYS = [
  "REGISTRY_FETCH_LOGIN_ID",
  "REGISTRY_FETCH_PASSWORD",
  "REGISTRY_FETCH_BASE_URL",
] as const;
let saved: Record<string, string | undefined> = {};

const fakeBrowserFactory = async () => ({
  async login() {
    /* no-op */
  },
  async searchByRealEstateNumber() {
    return { found: true };
  },
  async downloadRegistryPdf() {
    return Buffer.from("%PDF");
  },
  async close() {
    /* no-op */
  },
});

beforeEach(() => {
  __resetRegistryFetchThrottleForTest();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getRegistryFetchProvider: credentials 注入(DB-over-env 配線)", () => {
  it("env 未設定でも credentials 注入があれば provider を解決(DB 由来資格情報を使う)", () => {
    const provider = getRegistryFetchProvider({
      browserFactory: fakeBrowserFactory,
      credentials: { loginId: "db-id", password: "db-pw" },
    });
    expect(provider).toBeInstanceOf(OfficialRegistryProvider);
    expect(
      isRegistryAutoFetchProviderConfigured({
        browserFactory: fakeBrowserFactory,
        credentials: { loginId: "db-id", password: "db-pw" },
      }),
    ).toBe(true);
  });

  it("credentials が null(DB空・env空)なら null(501 維持)", () => {
    const provider = getRegistryFetchProvider({
      browserFactory: fakeBrowserFactory,
      credentials: { loginId: null, password: null },
    });
    expect(provider).toBeNull();
    expect(
      isRegistryAutoFetchProviderConfigured({
        browserFactory: fakeBrowserFactory,
        credentials: { loginId: null, password: null },
      }),
    ).toBe(false);
  });

  it("credentials 未注入 + env 設定なら env を使う(後方互換)", () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "env-id";
    process.env.REGISTRY_FETCH_PASSWORD = "env-pw";
    const provider = getRegistryFetchProvider({ browserFactory: fakeBrowserFactory });
    expect(provider).toBeInstanceOf(OfficialRegistryProvider);
  });

  it("credentials 注入があっても browserFactory 無しなら null(readiness 据え置き=本番501維持)", () => {
    const provider = getRegistryFetchProvider({
      credentials: { loginId: "db-id", password: "db-pw" },
    });
    expect(provider).toBeNull();
  });
});
