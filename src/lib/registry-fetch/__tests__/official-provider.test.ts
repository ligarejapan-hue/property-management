import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  OfficialRegistryProvider,
  type RegistryBrowserPage,
} from "../official-provider";
import { RegistryFetchError } from "../errors";
import type { RegistryFetchProvider } from "../types";

// テスト用の最小ブラウザページ（実 Playwright を起動しない注入境界の確認用）。
function makeFakePage(): RegistryBrowserPage {
  return {
    async goto() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  };
}

describe("OfficialRegistryProvider（PR-1 scaffold・外部接続なし）", () => {
  it("RegistryFetchProvider に準拠し name='official'", () => {
    const provider: RegistryFetchProvider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
    });
    expect(provider.name).toBe("official");
    expect(typeof provider.fetchRegistryPdf).toBe("function");
  });

  it("browserFactory 未注入なら provider_error で安全停止（外部接続不能）", async () => {
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
    });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "0123", ref: "prop-1" }),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "0123", ref: "prop-1" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("browserFactory を注入しても PR-1 では実操作未実装ゆえ provider_error（実取得は走らない）", async () => {
    let factoryCalled = false;
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
      browserFactory: async () => {
        factoryCalled = true;
        return makeFakePage();
      },
    });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "0123", ref: "prop-1" }),
    ).rejects.toMatchObject({ code: "provider_error" });
    // PR-1 では実ブラウザ操作（factory 呼び出し含む実取得）に到達しない設計。
    expect(factoryCalled).toBe(false);
  });

  it("C-1. official-provider.ts は Playwright を静的 import / require しない（バンドル混入防止）", () => {
    // 契約: Playwright は将来 resolveDefaultRegistryBrowserFactory() 内の動的 import で
    // のみ読み込む。OfficialRegistryProvider クラス自体が playwright を静的 import しない
    // 構造を保つことで、value import 連鎖（auto-fetch → me/permissions route）での
    // サーバーバンドル混入を防ぐ。
    const src = fs.readFileSync(
      path.resolve(__dirname, "../official-provider.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /from\s+["'](playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)["']/,
    );
    expect(src).not.toMatch(
      /import\s+["'](playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)["']/,
    );
    expect(src).not.toMatch(
      /require\s*\(\s*["'](playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)["']\s*\)/,
    );
  });

  it("失敗例外（RegistryFetchError）に secret/PII を載せない", async () => {
    const SECRET_ID = "SUPER_SECRET_LOGIN_ID";
    const SECRET_PW = "SUPER_SECRET_PASSWORD";
    const provider = new OfficialRegistryProvider({
      loginId: SECRET_ID,
      password: SECRET_PW,
      baseUrl: "https://example.test/secret-base",
    });
    try {
      await provider.fetchRegistryPdf({
        realEstateNumber: "0123",
        ref: "prop-1",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryFetchError);
      const serialized = `${(err as Error).name} ${(err as Error).message} ${
        (err as Error).stack ?? ""
      } ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
      expect(serialized).not.toContain(SECRET_ID);
      expect(serialized).not.toContain(SECRET_PW);
      expect(serialized).not.toContain("example.test");
    }
  });
});
