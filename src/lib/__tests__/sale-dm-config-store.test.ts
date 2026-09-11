import { vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: { saleDmConfig: { findUnique: vi.fn() } } }));
// saleDmConfigFromEnv(全 env=APIキー含む を読む)を spy 化(実装は passthrough)。
// 公開 /t 用 loadSaleDmLpUrl がこれを呼ばない=キーを materialize しないことを検証するため。
vi.mock("../sale-dm-letter/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sale-dm-letter/config")>();
  return { ...actual, saleDmConfigFromEnv: vi.fn(actual.saleDmConfigFromEnv) };
});
// decryptSecret を spy 化(実装は passthrough)。公開 /t ページ描画用リーダーがこれを呼ばない
// (=秘匿キー列に触らない)ことを検証するため。
vi.mock("../sale-dm-letter/secret-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sale-dm-letter/secret-crypto")>();
  return { ...actual, decryptSecret: vi.fn(actual.decryptSecret) };
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import prismaMock from "@/lib/prisma";
import { saleDmConfigFromEnv, saleDmLpUrlFromEnv, saleDmPublicPageConfigFromEnv } from "../sale-dm-letter/config";
import { loadSaleDmConfig, loadSaleDmLpUrl, loadSaleDmPublicPageConfig } from "../sale-dm-letter/config-store";
import { encryptSecret, decryptSecret } from "../sale-dm-letter/secret-crypto";

const pm = prismaMock as never as { saleDmConfig: { findUnique: ReturnType<typeof vi.fn> } };
const ENV = process.env;
const MKEY = crypto.randomBytes(32).toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV, SALE_DM_SETTINGS_ENC_KEY: MKEY };
  for (const k of [
    "SALE_DM_LETTER_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SALE_DM_LETTER_MODEL",
    "SALE_DM_TRACKING_BASE_URL", "SALE_DM_LP_URL", "SALE_DM_SENDER_NAME", "SALE_DM_SENDER_CONTACT", "NEXT_PUBLIC_USE_MOCK",
    "SALE_DM_LP_PUBLIC_ENABLED",
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

describe("saleDmPublicPageConfigFromEnv: lpPublicEnabled(公開LPロールアウトゲート)の env 解析", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    [undefined, false],
    ["yes", false],
  ] as const)("SALE_DM_LP_PUBLIC_ENABLED=%s → %s", (v, expected) => {
    if (v === undefined) delete process.env.SALE_DM_LP_PUBLIC_ENABLED;
    else process.env.SALE_DM_LP_PUBLIC_ENABLED = v;
    expect(saleDmPublicPageConfigFromEnv().lpPublicEnabled).toBe(expected);
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

describe("loadSaleDmPublicPageConfig: 公開/tページ描画用・送付元/追跡baseだけ解決(APIキー列は読まない/復号しない)", () => {
  it("DBの3項目を絶対http検証つきで返す(DB優先)", async () => {
    process.env.SALE_DM_TRACKING_BASE_URL = "https://env-track.example.com";
    process.env.SALE_DM_SENDER_NAME = "env社";
    process.env.SALE_DM_SENDER_CONTACT = "env-contact";
    pm.saleDmConfig.findUnique.mockResolvedValue({
      trackingBaseUrl: "https://db-track.example.com",
      senderName: "DB社", senderContact: "DB-contact",
    });
    const c = await loadSaleDmPublicPageConfig();
    expect(c.trackingBaseUrl).toBe("https://db-track.example.com");
    expect(c.senderName).toBe("DB社");
    expect(c.senderContact).toBe("DB-contact");
  });

  it("DB項目が null なら env へフォールバック", async () => {
    process.env.SALE_DM_TRACKING_BASE_URL = "https://env-track.example.com";
    process.env.SALE_DM_SENDER_NAME = "env社";
    process.env.SALE_DM_SENDER_CONTACT = "env-contact";
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null, senderName: null, senderContact: null });
    const c = await loadSaleDmPublicPageConfig();
    expect(c.trackingBaseUrl).toBe("https://env-track.example.com");
    expect(c.senderName).toBe("env社");
    expect(c.senderContact).toBe("env-contact");
  });

  it("非絶対http/未設定の trackingBaseUrl は undefined(fail-closed 側に委譲)", async () => {
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: "not-a-url", senderName: null, senderContact: null });
    const c = await loadSaleDmPublicPageConfig();
    expect(c.trackingBaseUrl).toBeUndefined();
  });

  it("DB取得失敗でも env フォールバック(fail-safe・例外を投げない)", async () => {
    process.env.SALE_DM_TRACKING_BASE_URL = "https://env-track.example.com";
    pm.saleDmConfig.findUnique.mockRejectedValue(new Error("db down"));
    const c = await loadSaleDmPublicPageConfig();
    expect(c.trackingBaseUrl).toBe("https://env-track.example.com");
  });

  it("外部LPの住所(lpUrl)はページ描画に使わないので読まない・返さない(転送は loadSaleDmLpUrl 側)", async () => {
    process.env.SALE_DM_LP_URL = "https://env-lp.example.com";
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null, senderName: null, senderContact: null });
    const c = await loadSaleDmPublicPageConfig();
    expect("lpUrl" in c).toBe(false);
    const arg = pm.saleDmConfig.findUnique.mock.calls[0][0] as { select?: Record<string, boolean> };
    expect(arg.select?.lpUrl).toBeUndefined();
  });

  // ここから下 3 件が finding 1 の要求(sale-dm-config-store.test.ts:119-126 のガードをこの新リーダーにも張る):
  // select 形に *ApiKeyEnc が無い・decryptSecret を呼ばない・全設定env(saleDmConfigFromEnv)も呼ばない。
  it("senderName/senderContact/trackingBaseUrl 列だけを select する(公開経路で課金APIキー列を取得/復号しない)", async () => {
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null, senderName: null, senderContact: null });
    await loadSaleDmPublicPageConfig();
    const arg = pm.saleDmConfig.findUnique.mock.calls[0][0] as { select?: Record<string, boolean> };
    expect(arg.select).toEqual({ senderName: true, senderContact: true, trackingBaseUrl: true });
    expect(arg.select?.anthropicApiKeyEnc).toBeUndefined();
    expect(arg.select?.openaiApiKeyEnc).toBeUndefined();
  });
  it("decryptSecret を呼ばない(秘匿キーの復号処理に一切触れない)", async () => {
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null, senderName: null, senderContact: null });
    await loadSaleDmPublicPageConfig();
    expect(decryptSecret).not.toHaveBeenCalled();
  });
  it("全設定env読み込み(saleDmConfigFromEnv=APIキーも読む)を呼ばない(公開経路でキーを materialize しない)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-be-read";
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null, senderName: null, senderContact: null });
    await loadSaleDmPublicPageConfig();
    expect(saleDmConfigFromEnv).not.toHaveBeenCalled();
  });

  it("lpPublicEnabled は DB列を持たず env 値をそのまま通す(DB行があっても env が権威)", async () => {
    process.env.SALE_DM_LP_PUBLIC_ENABLED = "1";
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null, senderName: null, senderContact: null });
    expect((await loadSaleDmPublicPageConfig()).lpPublicEnabled).toBe(true);
    delete process.env.SALE_DM_LP_PUBLIC_ENABLED;
    expect((await loadSaleDmPublicPageConfig()).lpPublicEnabled).toBe(false);
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
