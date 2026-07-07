import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  isRegistrySecretCryptoConfigured,
  encryptRegistrySecret,
  decryptRegistrySecret,
} from "../secret-crypto";

const KEY = crypto.randomBytes(32).toString("base64");

describe("registry secret-crypto", () => {
  beforeEach(() => {
    process.env.REGISTRY_SETTINGS_ENC_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.REGISTRY_SETTINGS_ENC_KEY;
  });

  it("鍵設定済みで isConfigured=true・encrypt→decrypt 往復", () => {
    expect(isRegistrySecretCryptoConfigured()).toBe(true);
    const blob = encryptRegistrySecret("touki-pass-123");
    expect(blob).toMatch(/^v1:/);
    expect(decryptRegistrySecret(blob)).toBe("touki-pass-123");
  });

  it("鍵未設定は isConfigured=false・encrypt/decrypt throw(平文保存させない)", () => {
    delete process.env.REGISTRY_SETTINGS_ENC_KEY;
    expect(isRegistrySecretCryptoConfigured()).toBe(false);
    expect(() => encryptRegistrySecret("x")).toThrow();
    expect(() => decryptRegistrySecret("v1:a:b:c")).toThrow();
  });

  it("鍵の長さ不正(base64 32byte以外)は未設定扱い(fail-closed)", () => {
    process.env.REGISTRY_SETTINGS_ENC_KEY = Buffer.from("short").toString("base64");
    expect(isRegistrySecretCryptoConfigured()).toBe(false);
  });

  it("改ざん(GCM tag 不一致)は decrypt throw", () => {
    const blob = encryptRegistrySecret("secret");
    const parts = blob.split(":");
    parts[2] = Buffer.from("0".repeat(16)).toString("base64");
    expect(() => decryptRegistrySecret(parts.join(":"))).toThrow();
  });

  it("書式不正は decrypt throw", () => {
    expect(() => decryptRegistrySecret("not-a-valid-blob")).toThrow();
  });
});
