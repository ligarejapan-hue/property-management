import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: { registryFetchConfig: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/registry-fetch/secret-crypto", () => ({
  decryptRegistrySecret: vi.fn((enc: string) => enc.replace(/^enc\(/, "").replace(/\)$/, "")),
}));

import prisma from "@/lib/prisma";
import { decryptRegistrySecret } from "@/lib/registry-fetch/secret-crypto";
import { loadRegistryFetchCredentials } from "../config-store";

const pm = prisma as unknown as { registryFetchConfig: { findUnique: Mock } };
const ENV_KEYS = ["REGISTRY_FETCH_LOGIN_ID", "REGISTRY_FETCH_PASSWORD", "REGISTRY_FETCH_BASE_URL"];

beforeEach(() => {
  vi.clearAllMocks();
  (decryptRegistrySecret as Mock).mockImplementation((enc: string) =>
    enc.replace(/^enc\(/, "").replace(/\)$/, ""),
  );
  ENV_KEYS.forEach((k) => delete process.env[k]);
});
afterEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
});

describe("loadRegistryFetchCredentials", () => {
  it("DB の復号値を優先(env より)", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "env-id";
    process.env.REGISTRY_FETCH_PASSWORD = "env-pw";
    pm.registryFetchConfig.findUnique.mockResolvedValue({
      loginIdEnc: "enc(db-id)",
      passwordEnc: "enc(db-pw)",
      baseUrl: "https://db",
    });
    const r = await loadRegistryFetchCredentials();
    expect(r).toEqual({ loginId: "db-id", password: "db-pw" });
  });

  it("DB が空の項目は env にフォールバック", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "env-id";
    process.env.REGISTRY_FETCH_PASSWORD = "env-pw";
    process.env.REGISTRY_FETCH_BASE_URL = "https://env";
    pm.registryFetchConfig.findUnique.mockResolvedValue({
      loginIdEnc: null,
      passwordEnc: null,
      baseUrl: null,
    });
    const r = await loadRegistryFetchCredentials();
    expect(r).toEqual({ loginId: "env-id", password: "env-pw" });
  });

  it("DB 行なし(null)は env", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "env-id";
    pm.registryFetchConfig.findUnique.mockResolvedValue(null);
    const r = await loadRegistryFetchCredentials();
    expect(r.loginId).toBe("env-id");
    expect(r.password).toBeNull();
  });

  it("DB 障害は throw せず env フォールバック", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "env-id";
    pm.registryFetchConfig.findUnique.mockRejectedValue(new Error("db down"));
    const r = await loadRegistryFetchCredentials();
    expect(r.loginId).toBe("env-id");
  });

  it("復号不能(壊れた暗号文)は throw せず env フォールバック", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "env-id";
    (decryptRegistrySecret as Mock).mockImplementationOnce(() => {
      throw new Error("bad ciphertext");
    });
    pm.registryFetchConfig.findUnique.mockResolvedValue({
      loginIdEnc: "enc(broken)",
      passwordEnc: null,
      baseUrl: null,
    });
    const r = await loadRegistryFetchCredentials();
    expect(r.loginId).toBe("env-id");
  });

  it("全て未設定は null", async () => {
    pm.registryFetchConfig.findUnique.mockResolvedValue(null);
    const r = await loadRegistryFetchCredentials();
    expect(r).toEqual({ loginId: null, password: null });
  });
});
