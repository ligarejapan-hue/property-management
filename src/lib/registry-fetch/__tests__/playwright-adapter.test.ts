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

import {
  resolveDefaultRegistryBrowserFactory,
  DEFAULT_REGISTRY_BASE_URL,
  DEFAULT_REGISTRY_LOGIN_PATH,
  extractLocationCandidateRows,
} from "../auto-fetch";
import { RegistryFetchError } from "../errors";

/** name=="TimeoutError" の擬似エラー（Playwright TimeoutError 相当）。 */
function makeTimeoutError(): Error {
  const e = new Error("timeout exceeded");
  e.name = "TimeoutError";
  return e;
}

function makeFakeChromium() {
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn<(url: string) => Promise<undefined>>(async () => undefined),
    fill: vi.fn<(selector: string, value: string) => Promise<undefined>>(
      async () => undefined,
    ),
    click: vi.fn<(selector: string) => Promise<undefined>>(
      async () => undefined,
    ),
    waitForSelector: vi.fn(async () => ({})),
    waitForEvent: vi.fn(async () => ({
      createReadStream: async () => Readable.from([Buffer.from("%PDF-1.4 dl")]),
    })),
    $$eval: vi.fn(async () => [] as unknown[]),
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
  "REGISTRY_FETCH_SELECTORS_CALIBRATED",
  "REGISTRY_FETCH_TIMEOUT_MS",
  "REGISTRY_FETCH_LOGIN_PATH",
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

  it("opt-in env が official でもセレクタ未校正なら undefined（= 501 維持・CodexP1）", () => {
    // CodexP1: REGISTRY_SELECTORS は TODO プレースホルダ。校正フラグ無しで opt-in だけでは
    // 実サイトを誤セレクタで操作してしまうため、本番経路では undefined を維持する。
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    expect(resolveDefaultRegistryBrowserFactory()).toBeUndefined();
  });

  it("opt-in env が official かつ校正フラグありなら factory を返す（CodexP1）", () => {
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    process.env.REGISTRY_FETCH_SELECTORS_CALIBRATED = "true";
    expect(typeof resolveDefaultRegistryBrowserFactory()).toBe("function");
  });

  it("校正フラグのみ（opt-in env 無し）では undefined（両方必須・CodexP1）", () => {
    process.env.REGISTRY_FETCH_SELECTORS_CALIBRATED = "true";
    expect(resolveDefaultRegistryBrowserFactory()).toBeUndefined();
  });

  it("校正フラグが 'true' 以外（例: 1/yes）では undefined（明示 true のみ受理・CodexP1）", () => {
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    process.env.REGISTRY_FETCH_SELECTORS_CALIBRATED = "1";
    expect(resolveDefaultRegistryBrowserFactory()).toBeUndefined();
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

  it("C9: searchByLocation は 所在/地番/家屋番号 を fill→検索 click→結果行を候補へ変換", async () => {
    const f = makeFakeChromium();
    f.page.$$eval = vi.fn(async () => [
      { candidateRef: "c1", address: "東京都千代田区丸の内1-1", lotNumber: "1番1", buildingNumber: null, realEstateNumber: "1234567890123" },
      { candidateRef: "", address: "東京都千代田区丸の内1-2", lotNumber: "1番2", buildingNumber: null, realEstateNumber: null },
    ]);
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    const candidates = await page.searchByLocation!({
      address: "東京都千代田区丸の内1",
      lotNumber: "1番",
      buildingNumber: null,
    });
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "東京都千代田区丸の内1");
    expect(f.page.click).toHaveBeenCalled();
    expect(candidates).toHaveLength(2);
    expect(candidates[0].realEstateNumber).toBe("1234567890123");
    // candidateRef 空は row-index フォールバックで必ず非空。
    expect(candidates[1].candidateRef).not.toBe("");
  });

  it("C10: searchByLocation の結果待ちタイムアウトは timeout(not_found にしない)", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await expect(page.searchByLocation!({ address: "x" })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("C11: extractLocationCandidateRows は candidateRef を data-ref 属性から読む(textContent でない)", () => {
    const makeEl = (dataRef: string | null, cells: Record<string, string>): Element =>
      ({
        getAttribute: (name: string) => (name === "data-ref" ? dataRef : null),
        querySelector: (sel: string) =>
          sel === "[data-ref]"
            ? null
            : cells[sel] !== undefined
              ? ({ textContent: cells[sel] } as unknown as Element)
              : null,
      }) as unknown as Element;
    const rows = extractLocationCandidateRows([
      makeEl("ref-abc", { ".address": "東京都千代田区丸の内1-1", ".ren": "1234567890123" }),
      makeEl(null, { ".address": "東京都千代田区丸の内1-2" }),
    ]);
    // candidateRef はラベルの textContent ではなく data-ref 属性値。
    expect(rows[0].candidateRef).toBe("ref-abc");
    expect(rows[0].address).toBe("東京都千代田区丸の内1-1");
    expect(rows[0].realEstateNumber).toBe("1234567890123");
    // data-ref 無しは空(呼び出し側で row-index フォールバック)。
    expect(rows[1].candidateRef).toBe("");
  });

  // CodexP2-1: baseUrl 省略時は documented default を使い、相対 URL へ遷移しない。
  it("C8: login で baseUrl 省略時は DEFAULT_REGISTRY_BASE_URL を前置した絶対 URL へ goto する", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "the-id", password: "the-pw" }); // baseUrl 省略
    expect(f.page.goto).toHaveBeenCalledTimes(1);
    const gotoUrl = f.page.goto.mock.calls[0][0];
    // 既定 base が前置された絶対 URL（相対 "/login" のままにしない）。
    expect(gotoUrl.startsWith(DEFAULT_REGISTRY_BASE_URL)).toBe(true);
    expect(/^https?:\/\//.test(gotoUrl)).toBe(true);
    expect(gotoUrl).not.toBe("/login");
  });

  it("C8b: DEFAULT_REGISTRY_BASE_URL は https の絶対 URL（末尾スラッシュ無し）", () => {
    expect(/^https:\/\//.test(DEFAULT_REGISTRY_BASE_URL)).toBe(true);
    expect(DEFAULT_REGISTRY_BASE_URL.endsWith("/")).toBe(false);
  });

  it("C8c: login で baseUrl 明示時はそれを優先（既定で上書きしない）", async () => {
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
    const gotoUrl = f.page.goto.mock.calls[0][0];
    expect(gotoUrl.startsWith("https://reg.test")).toBe(true);
  });

  // CodexP2-2: search のセットアップ(fill/click)由来 timeout は not_found ではなく provider_error。
  // CodexP2: login のパスは env（REGISTRY_FETCH_LOGIN_PATH）で上書きできる。
  // 既定の "/login" は実サービスのログインパスと一致が未確証ゆえ、live キャリブレーション時に
  // 固定値を確定する前に env で校正できるようにする（誤った固定値で確定しない）。
  it("C14: DEFAULT_REGISTRY_LOGIN_PATH は '/' 始まりの相対パス（base に前置する想定）", () => {
    expect(DEFAULT_REGISTRY_LOGIN_PATH.startsWith("/")).toBe(true);
  });

  it("C15: login で baseUrl 省略時は default base + default login path の絶対 URL へ goto する", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw" });
    const gotoUrl = f.page.goto.mock.calls[0][0];
    expect(gotoUrl).toBe(`${DEFAULT_REGISTRY_BASE_URL}${DEFAULT_REGISTRY_LOGIN_PATH}`);
  });

  it("C16: REGISTRY_FETCH_LOGIN_PATH を設定すると login の goto パスがそれで上書きされる", async () => {
    process.env.REGISTRY_FETCH_LOGIN_PATH = "/svc/auth/signin";
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" });
    const gotoUrl = f.page.goto.mock.calls[0][0];
    expect(gotoUrl).toBe("https://reg.test/svc/auth/signin");
    // 既定の "/login" は使われない。
    expect(gotoUrl).not.toContain("/login");
  });

  it("C17: REGISTRY_FETCH_LOGIN_PATH 未設定なら既定 login path（/login）を使う", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" });
    const gotoUrl = f.page.goto.mock.calls[0][0];
    expect(gotoUrl).toBe(`https://reg.test${DEFAULT_REGISTRY_LOGIN_PATH}`);
  });

  it("C9: searchByRealEstateNumber の結果待ち(waitForSelector)の timeout は not_found にせず timeout 系に分類する（CodexP2）", async () => {
    // CodexP2: 検索ページが遅い / セレクタ変更 / 結果行レンダリング前の timeout を
    // 「該当なし（found:false → not_found 404）」と誤分類しない。結果待ちの TimeoutError は
    // 連携不備（リトライ可能）であって「謄本が存在しない」ではないため timeout/provider_error
    // に分類し、真の「結果なし」とは区別する。
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    // found:false（not_found 経路）にはならず、RegistryFetchError（timeout 系）を投げる。
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("C9b: search の fill が timeout を投げたら provider_error（not_found にしない）", async () => {
    const f = makeFakeChromium();
    f.page.fill = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toMatchObject({
      // RegistryFetchError("provider_error")（found:false で返さない）。
      code: "provider_error",
    });
  });

  it("C9c: search の click が timeout を投げたら provider_error（not_found にしない）", async () => {
    const f = makeFakeChromium();
    f.page.click = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("C9d: search の waitForSelector が非 timeout の例外なら provider_error", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async () => {
      throw new Error("boom");
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  // CodexP2: factory のセットアップ部分失敗（launch 後に newContext/newPage が reject）で
  // 起動済みリソース（browser/context）を確実に close してから throw する（プロセスリーク防止）。
  it("C10: newContext が reject したら起動済み browser を close してから throw する", async () => {
    const f = makeFakeChromium();
    const boom = new Error("newContext failed");
    f.browser.newContext = vi.fn(async () => {
      throw boom;
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    await expect(factory!()).rejects.toBe(boom);
    // launch は成功しているので browser は close されねばならない。
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    // context は生成されていないので close 対象外。
    expect(f.context.close).not.toHaveBeenCalled();
  });

  it("C11: newPage が reject したら起動済み context→browser を close してから throw する", async () => {
    const f = makeFakeChromium();
    const boom = new Error("newPage failed");
    f.context.newPage = vi.fn(async () => {
      throw boom;
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    await expect(factory!()).rejects.toBe(boom);
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });

  it("C12: 部分失敗時の close が失敗しても元の起動エラーを throw する（close エラーは握りつぶす）", async () => {
    const f = makeFakeChromium();
    const boom = new Error("newPage failed");
    f.context.newPage = vi.fn(async () => {
      throw boom;
    });
    f.context.close = vi.fn(async () => {
      throw new Error("context close failed");
    });
    f.browser.close = vi.fn(async () => {
      throw new Error("browser close failed");
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    // close 失敗にかかわらず、元の起動エラーが伝播する。
    await expect(factory!()).rejects.toBe(boom);
  });

  it("C13: launch 自体が reject したら close を呼ばずに throw する（起動済みリソースなし）", async () => {
    const f = makeFakeChromium();
    const boom = new Error("launch failed");
    f.chromium.launch = vi.fn(async () => {
      throw boom;
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    await expect(factory!()).rejects.toBe(boom);
    expect(f.browser.close).not.toHaveBeenCalled();
    expect(f.context.close).not.toHaveBeenCalled();
  });
});
