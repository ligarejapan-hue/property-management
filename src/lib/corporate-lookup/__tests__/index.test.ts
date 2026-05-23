/**
 * lookupCorporateNumber orchestrator と isCorporateLookupConfigured のテスト。
 *
 * - env 未設定 → CorporateLookupError("NOT_CONFIGURED")
 * - NEXT_PUBLIC_USE_MOCK=true → MockCorporateLookupProvider が呼ばれる
 * - mock provider: 1234567890123 found / 9999999999999 not found / 8888888888888 closed
 * - capability flag: env 状況で適切に true/false
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lookupCorporateNumber,
  isCorporateLookupConfigured,
  CorporateLookupError,
} from "../index";
import { MockCorporateLookupProvider } from "../mock-provider";

const ENV_KEYS = [
  "NEXT_PUBLIC_USE_MOCK",
  "CORPORATE_NUMBER_API_APP_ID",
  "CORPORATE_NUMBER_API_URL",
  "CORPORATE_NUMBER_API_TIMEOUT_MS",
] as const;

describe("lookupCorporateNumber orchestrator", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("env 未設定なら NOT_CONFIGURED を throw", async () => {
    await expect(lookupCorporateNumber("1234567890123")).rejects.toBeInstanceOf(
      CorporateLookupError,
    );
    await expect(lookupCorporateNumber("1234567890123")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("NEXT_PUBLIC_USE_MOCK=true なら mock provider 経由", async () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    const r = await lookupCorporateNumber("1234567890123");
    expect(r.found).toBe(true);
    expect(r.source).toBe("mock-corporate-lookup");
  });

  it("isCorporateLookupConfigured: 未設定 → false", () => {
    expect(isCorporateLookupConfigured()).toBe(false);
  });

  it("isCorporateLookupConfigured: mock=true → true", () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    expect(isCorporateLookupConfigured()).toBe(true);
  });

  it("isCorporateLookupConfigured: APP_ID 設定済 → true", () => {
    process.env.CORPORATE_NUMBER_API_APP_ID = "abc";
    expect(isCorporateLookupConfigured()).toBe(true);
  });
});

describe("MockCorporateLookupProvider", () => {
  it("既定値 → found", async () => {
    const r = await new MockCorporateLookupProvider().lookup("1234567890123");
    expect(r.found).toBe(true);
    expect(r.isClosed).toBe(false);
    expect(r.record!.name).toBe("モック株式会社");
    expect(r.record!.address).toBe("東京都千代田区丸の内1-1-1");
  });

  it("9999999999999 → not found", async () => {
    const r = await new MockCorporateLookupProvider().lookup("9999999999999");
    expect(r.found).toBe(false);
    expect(r.record).toBeNull();
  });

  it("8888888888888 → closed", async () => {
    const r = await new MockCorporateLookupProvider().lookup("8888888888888");
    expect(r.found).toBe(true);
    expect(r.isClosed).toBe(true);
    expect(r.closeDate).toBe("2024-12-31");
  });
});
