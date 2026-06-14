/**
 * PR-2: resolveDefaultRegistryBrowserFactory の Playwright adapter（外部接続なし）。
 *
 * 実 playwright を読み込まず、注入した fake chromiumLoader（fake chromium/browser/context/page）で
 * adapter の「翻訳」を検証する: launch→newContext→newPage の起動シーケンス、login/search/download/
 * close が page 操作へ委譲されること、download が Buffer を返すこと（fetch( 不使用）。
 *
 * 実サイトのセレクタ/画面遷移は live 環境でのみ確定するため、本テストは **委譲と起動/終了
 * シーケンス** の検証に留める（セレクタ正しさは live キャリブレーションに委ねる）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";

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

import { resolveDefaultRegistryBrowserFactory } from "../auto-fetch";

function makeFakeChromium() {
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForEvent: vi.fn(async () => ({
      createReadStream: async () => Readable.from([Buffer.from("%PDF-1.4 dl")]),
    })),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  const chromium = { launch: vi.fn(async () => browser) };
  const loader = vi.fn(async () => ({ chromium }));
  return { loader, chromium, browser, context, page };
}

const ENV_KEYS = [
  "REGISTRY_FETCH_PROVIDER",
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

describe("resolveDefaultRegistryBrowserFactory（PR-2 adapter・fake chromium）", () => {
  it("C7: chromiumLoader 注入時は opt-in env なしでも factory を返す（テスト隔離）", () => {
    const { loader } = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: loader,
    });
    expect(typeof factory).toBe("function");
    // factory を作るだけでは loader を呼ばない（起動は factory() 呼び出し時）。
    expect(loader).not.toHaveBeenCalled();
  });

  it("opt-in env（REGISTRY_FETCH_PROVIDER=official）が無く loader 未注入なら undefined（= 501 維持）", () => {
    expect(resolveDefaultRegistryBrowserFactory()).toBeUndefined();
  });

  it("opt-in env が official なら（loader 未注入でも）factory を返す", () => {
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    expect(typeof resolveDefaultRegistryBrowserFactory()).toBe("function");
  });

  it("C1: factory() が chromium.launch({headless:true})→newContext({acceptDownloads:true})→newPage を順に呼ぶ", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    await factory!();
    expect(f.loader).toHaveBeenCalledTimes(1);
    expect(f.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true }),
    );
    expect(f.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ acceptDownloads: true }),
    );
    expect(f.context.newPage).toHaveBeenCalledTimes(1);
  });

  it("C2: factory() は RegistryBrowserPage（login/search/download/close）を返す", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    expect(typeof page.login).toBe("function");
    expect(typeof page.searchByRealEstateNumber).toBe("function");
    expect(typeof page.downloadRegistryPdf).toBe("function");
    expect(typeof page.close).toBe("function");
  });

  it("C3: login が goto(baseUrl) と ID/PW の fill・submit click へ委譲する", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({
      loginId: "the-id",
      password: "the-pw",
      baseUrl: "https://reg.test",
    });
    expect(f.page.goto).toHaveBeenCalled();
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "the-id");
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "the-pw");
    expect(f.page.click).toHaveBeenCalled();
  });

  it("C4: searchByRealEstateNumber が番号 fill・検索 click へ委譲し found を返す", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    const outcome = await page.searchByRealEstateNumber("1234567890123");
    expect(f.page.fill).toHaveBeenCalledWith(
      expect.any(String),
      "1234567890123",
    );
    expect(f.page.click).toHaveBeenCalled();
    expect(outcome.found).toBe(true);
  });

  it("C5: downloadRegistryPdf が download を待って Buffer を返す（fetch( 不使用）", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    const buf = await page.downloadRegistryPdf();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(f.page.waitForEvent).toHaveBeenCalledWith(
      "download",
      expect.anything(),
    );
  });

  it("C6: close が context.close → browser.close を呼ぶ", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.close();
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });
});
