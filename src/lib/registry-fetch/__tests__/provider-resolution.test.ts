/**
 * PR-1: getRegistryFetchProvider() の解決ロジック（外部接続なし）。
 *
 * 最重要の不変条件: **REGISTRY_FETCH_* 未設定 → null → route 501 維持 = 本番挙動不変。**
 * env が揃えば OfficialRegistryProvider を返すが、PR-1 では browserFactory を注入しないため
 * 実取得（fetchRegistryPdf）は provider_error で安全停止し、本番に外部接続は発生しない。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// auto-fetch.ts は @/lib/prisma / @/lib/api-helpers（→ next-auth → next/server）を
// transitively に import するため、DB 接続・next/server 解決を避けて mock する
// （getRegistryFetchProvider 自体はこれらに触れない）。vi.mock は vitest が先頭へ巻き上げる。
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
} from "../auto-fetch";
import { OfficialRegistryProvider } from "../official-provider";
import { RegistryFetchError } from "../errors";

const ENV_KEYS = [
  "REGISTRY_FETCH_LOGIN_ID",
  "REGISTRY_FETCH_PASSWORD",
  "REGISTRY_FETCH_BASE_URL",
  "REGISTRY_FETCH_TIMEOUT_MS",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
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

describe("getRegistryFetchProvider（PR-1 解決ロジック）", () => {
  it("REGISTRY_FETCH_* 未設定なら null（= route 501 維持 = 本番挙動不変）", () => {
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("LOGIN_ID のみでは null（PASSWORD も必須）", () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("PASSWORD のみでは null（LOGIN_ID も必須）", () => {
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("LOGIN_ID + PASSWORD が揃えば OfficialRegistryProvider を返す", () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    const provider = getRegistryFetchProvider();
    expect(provider).toBeInstanceOf(OfficialRegistryProvider);
    expect(provider?.name).toBe("official");
    expect(isRegistryAutoFetchProviderConfigured()).toBe(true);
  });

  it("PR-1: 解決しても browserFactory 未注入ゆえ実取得は走らず provider_error（外部接続なし）", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    const provider = getRegistryFetchProvider();
    expect(provider).not.toBeNull();
    await expect(
      provider!.fetchRegistryPdf({ realEstateNumber: "0123", ref: "prop-1" }),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(
      provider!.fetchRegistryPdf({ realEstateNumber: "0123", ref: "prop-1" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});
