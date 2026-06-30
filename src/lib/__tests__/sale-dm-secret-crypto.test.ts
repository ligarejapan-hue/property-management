import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { encryptSecret, decryptSecret, isSecretCryptoConfigured } from "../sale-dm-letter/secret-crypto";

// APIキー等の秘匿値を AES-256-GCM で暗号化して DB 保存する(平文では持たない)。
// マスターキーは env SALE_DM_SETTINGS_ENC_KEY(base64 32バイト)=システム内部秘密。
const ENV = process.env;
const KEY = crypto.randomBytes(32).toString("base64");
beforeEach(() => {
  process.env = { ...ENV, SALE_DM_SETTINGS_ENC_KEY: KEY };
});
afterEach(() => {
  process.env = ENV;
});

describe("sale-dm secret-crypto", () => {
  it("encrypt→decrypt で元に戻る(round-trip)・暗号文は平文を含まない", () => {
    const plain = "sk-ant-xxxxx-very-secret-api-key";
    const blob = encryptSecret(plain);
    expect(blob).not.toContain(plain);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(decryptSecret(blob)).toBe(plain);
  });

  it("同じ平文でも毎回異なる暗号文(IV ランダム)", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("改ざんされた暗号文は復号失敗(GCM 認証タグ)", () => {
    const blob = encryptSecret("secret");
    const parts = blob.split(":");
    const tampered = `v1:${parts[1]}:${parts[2]}:${Buffer.from("tampered-ciphertext").toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("キー未設定なら isSecretCryptoConfigured=false・encrypt は throw(平文保存させない)", () => {
    delete process.env.SALE_DM_SETTINGS_ENC_KEY;
    expect(isSecretCryptoConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow();
  });

  it("32バイトでないマスターキーは未設定扱い(弱い鍵を弾く)", () => {
    process.env.SALE_DM_SETTINGS_ENC_KEY = Buffer.from("too-short").toString("base64");
    expect(isSecretCryptoConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow();
  });

  it("マスターキー設定時は isSecretCryptoConfigured=true", () => {
    expect(isSecretCryptoConfigured()).toBe(true);
  });
});
