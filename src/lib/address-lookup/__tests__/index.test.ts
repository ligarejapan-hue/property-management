import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isAddressLookupConfigured,
  lookupAddressByPostalCode,
  searchAddressByText,
  AddressLookupError,
} from "../index";

const ENV_KEYS = [
  "NEXT_PUBLIC_USE_MOCK",
  "ADDRESS_LOOKUP_PROVIDER",
  "ADDRESS_LOOKUP_API_KEY",
  "ADDRESS_LOOKUP_CLIENT_ID",
  "ADDRESS_LOOKUP_BASE_URL",
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

describe("isAddressLookupConfigured", () => {
  it("env 未設定なら false", () => {
    expect(isAddressLookupConfigured()).toBe(false);
  });

  it("API_KEY のみでは false（client_id / base_url も必要）", () => {
    process.env.ADDRESS_LOOKUP_API_KEY = "secret";
    expect(isAddressLookupConfigured()).toBe(false);
  });

  it("API_KEY + CLIENT_ID + BASE_URL が揃えば true", () => {
    process.env.ADDRESS_LOOKUP_API_KEY = "secret";
    process.env.ADDRESS_LOOKUP_CLIENT_ID = "cid";
    process.env.ADDRESS_LOOKUP_BASE_URL = "https://example.test";
    expect(isAddressLookupConfigured()).toBe(true);
  });

  it("NEXT_PUBLIC_USE_MOCK=true なら true", () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    expect(isAddressLookupConfigured()).toBe(true);
  });
});

describe("未設定時の lookup は NOT_CONFIGURED を throw（=route 503 の源）", () => {
  it("lookupAddressByPostalCode", async () => {
    await expect(lookupAddressByPostalCode("1000005")).rejects.toBeInstanceOf(
      AddressLookupError,
    );
    await expect(lookupAddressByPostalCode("1000005")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("searchAddressByText", async () => {
    await expect(searchAddressByText("東京都千代田区")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });
});

describe("mock モード（NEXT_PUBLIC_USE_MOCK=true）は外部 I/O なしで候補を返す", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
  });

  it("郵便番号 lookup は source=mock の候補を返す", async () => {
    const got = await lookupAddressByPostalCode("1000005");
    expect(Array.isArray(got)).toBe(true);
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].source).toBe("mock");
    expect(got[0].addressLine.length).toBeGreaterThan(0);
  });

  it("住所 search も配列を返す", async () => {
    const got = await searchAddressByText("東京都千代田区");
    expect(Array.isArray(got)).toBe(true);
    expect(got[0].source).toBe("mock");
  });
});
