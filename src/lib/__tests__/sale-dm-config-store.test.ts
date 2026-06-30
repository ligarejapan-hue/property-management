import { vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: { saleDmConfig: { findUnique: vi.fn() } } }));
// saleDmConfigFromEnv(全 env=APIキー含む を読む)を spy 化(実装は passthrough)。
// 公開 /t 用 loadSaleDmLpUrl がこれを呼ばない=キーを materialize しないことを検証するため。
vi.mock("../sale-dm-letter/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sale-dm-letter/config")>();
  return { ...actual, saleDmConfigFromEnv: vi.fn(actual.saleDmConfigFromEnv) };
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import prismaMock from "@/lib/prisma";
import { saleDmConfigFromEnv, saleDmLpUrlFromEnv } from "../sale-dm-letter/config";
import { loadSaleDmConfig, loadSaleDmLpUrl } from "../sale-dm-letter/config-store";
import { encryptSecret } from "../sale-dm-letter/secret-crypto";

const pm = prismaMock as never as { saleDmConfig: { findUnique: ReturnType<typeof vi.fn> } };
const ENV = process.env;
const MKEY = crypto.randomBytes(32).toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV, SALE_DM_SETTINGS_ENC_KEY: MKEY };
  for (const k of [
    "SALE_DM_LETTER_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SALE_DM_LETTER_MODEL",
    "SALE_DM_TRACKING_BASE_URL", "SALE_DM_LP_URL", "SALE_DM_SENDER_NAME", "SALE_DM_SENDER_CONTACT", "NEXT_PUBLIC_USE_MOCK",
  ]) delete process.env[k];
});
afterEach(() => { process.env = ENV; });

describe("saleDmConfigFromEnv", () => {
  it("env から解決する", () => {
    process.env.SALE_DM_LETTER_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "envkey";
    const c = saleDmConfigFromEnv();
    expect(c.provider).toBe("claude");
    expect(c.anthropicApiKey).toBe("envkey");
  });
  it("空白のみの値は null 扱い", () => {
    process.env.SALE_DM_LP_URL = "   ";
    expect(saleDmConfigFromEnv().lpUrl).toBeNull();
  });
});

describe("loadSaleDmConfig: DB→env 優先で解決", () => {
  it("DB行が無ければ env のみ", async () => {
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "envopen";
    pm.saleDmConfig.findUnique.mockResolvedValue(null);
    const c = await loadSaleDmConfig();
    expect(c.provider).toBe("openai");
    expect(c.openaiApiKey).toBe("envopen");
  });

  it("DB値が env を上書き・暗号化キーは復号して返す", async () => {
    process.env.SALE_DM_LETTER_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "envkey";
    pm.saleDmConfig.findUnique.mockResolvedValue({
      provider: "openai", model: null, trackingBaseUrl: "https://db.example.com", lpUrl: null,
      senderName: "DB社", senderContact: null,
      anthropicApiKeyEnc: encryptSecret("dbkey"), openaiApiKeyEnc: encryptSecret("dbopen"),
    });
    const c = await loadSaleDmConfig();
    expect(c.provider).toBe("openai"); // DB 優先
    expect(c.anthropicApiKey).toBe("dbkey"); // 復号
    expect(c.openaiApiKey).toBe("dbopen");
    expect(c.trackingBaseUrl).toBe("https://db.example.com");
    expect(c.senderName).toBe("DB社");
  });

  it("DB項目が null なら env にフォールバック(キーも)", async () => {
    process.env.SALE_DM_LP_URL = "https://env-lp.example.com";
    process.env.ANTHROPIC_API_KEY = "envkey";
    pm.saleDmConfig.findUnique.mockResolvedValue({
      provider: "claude", model: null, trackingBaseUrl: null, lpUrl: null,
      senderName: null, senderContact: null, anthropicApiKeyEnc: null, openaiApiKeyEnc: null,
    });
    const c = await loadSaleDmConfig();
    expect(c.lpUrl).toBe("https://env-lp.example.com");
    expect(c.anthropicApiKey).toBe("envkey");
  });

  it("DB取得が throw しても env フォールバック(fail-safe)", async () => {
    process.env.SALE_DM_LETTER_PROVIDER = "mock";
    pm.saleDmConfig.findUnique.mockRejectedValue(new Error("db down"));
    const c = await loadSaleDmConfig();
    expect(c.provider).toBe("mock");
  });

  it("復号失敗(壊れた/鍵不一致の暗号文)は env キーへフォールバック", async () => {
    process.env.ANTHROPIC_API_KEY = "envkey";
    pm.saleDmConfig.findUnique.mockResolvedValue({
      provider: "claude", model: null, trackingBaseUrl: null, lpUrl: null,
      senderName: null, senderContact: null, anthropicApiKeyEnc: "v1:bad:bad:bad", openaiApiKeyEnc: null,
    });
    const c = await loadSaleDmConfig();
    expect(c.anthropicApiKey).toBe("envkey");
  });
});

describe("loadSaleDmLpUrl: 公開/t用・既定LP URLだけ解決(APIキー列は読まない/復号しない)", () => {
  it("DBのlpUrlを絶対http検証して返す(DB優先)", async () => {
    process.env.SALE_DM_LP_URL = "https://env-lp.example.com";
    pm.saleDmConfig.findUnique.mockResolvedValue({ lpUrl: "https://db-lp.example.com" });
    expect(await loadSaleDmLpUrl()).toBe("https://db-lp.example.com");
  });

  it("DBにlpUrlが無ければ env lpUrl へフォールバック", async () => {
    process.env.SALE_DM_LP_URL = "https://env-lp.example.com";
    pm.saleDmConfig.findUnique.mockResolvedValue({ lpUrl: null });
    expect(await loadSaleDmLpUrl()).toBe("https://env-lp.example.com");
  });

  it("非絶対http/未設定は undefined(=/t は404 fail-closed)", async () => {
    pm.saleDmConfig.findUnique.mockResolvedValue({ lpUrl: "relative/path" });
    expect(await loadSaleDmLpUrl()).toBeUndefined();
  });

  it("lpUrl 列だけを select する(公開経路で課金APIキー列を取得/復号しない)", async () => {
    pm.saleDmConfig.findUnique.mockResolvedValue({ lpUrl: "https://x.example.com" });
    await loadSaleDmLpUrl();
    const arg = pm.saleDmConfig.findUnique.mock.calls[0][0] as { select?: Record<string, boolean> };
    expect(arg.select).toEqual({ lpUrl: true });
    expect(arg.select?.anthropicApiKeyEnc).toBeUndefined();
    expect(arg.select?.openaiApiKeyEnc).toBeUndefined();
  });

  it("DB取得失敗でも env フォールバック(fail-safe・例外を投げない)", async () => {
    process.env.SALE_DM_LP_URL = "https://env-lp.example.com";
    pm.saleDmConfig.findUnique.mockRejectedValue(new Error("db down"));
    expect(await loadSaleDmLpUrl()).toBe("https://env-lp.example.com");
  });

  it("全設定env読み込み(saleDmConfigFromEnv=APIキーも読む)を呼ばない(公開経路でキーを materialize しない)", async () => {
    process.env.SALE_DM_LP_URL = "https://env-lp.example.com";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-be-read";
    pm.saleDmConfig.findUnique.mockResolvedValue({ lpUrl: null });
    await loadSaleDmLpUrl();
    expect(saleDmConfigFromEnv).not.toHaveBeenCalled();
  });
});

describe("saleDmLpUrlFromEnv: LP URL だけを読む env リーダー(秘匿キーを読まない)", () => {
  it("SALE_DM_LP_URL を trim して返す", () => {
    process.env.SALE_DM_LP_URL = "  https://lp.example.com  ";
    expect(saleDmLpUrlFromEnv()).toBe("https://lp.example.com");
  });
  it("未設定/空白は null", () => {
    process.env.SALE_DM_LP_URL = "   ";
    expect(saleDmLpUrlFromEnv()).toBeNull();
  });
});
