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
  REGISTRY_FORCE_LOGIN_MARKER,
  extractLocationCandidateRows,
  splitAddressForLocationSearch,
  summarizeRegistryLoginError,
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
    selectOption: vi.fn<(selector: string, value: string) => Promise<string[]>>(
      async () => [],
    ),
    check: vi.fn<(selector: string) => Promise<undefined>>(
      async () => undefined,
    ),
    // 既定: 二重ログイン確認マーカーは「出ない」(=通常メニュー着地)を模す。login の
    // 突破ロジックはこのマーカー待ちが timeout したらスキップするので、既存 login テストは
    // 影響を受けない。二重ログインを試すテストだけこの mock を差し替える。
    waitForSelector: vi.fn(async (selector: string) => {
      if (selector === REGISTRY_FORCE_LOGIN_MARKER) throw makeTimeoutError();
      return {};
    }),
    waitForEvent: vi.fn(async () => ({
      createReadStream: async () => Readable.from([Buffer.from("%PDF-1.4 dl")]),
    })),
    $$eval: vi.fn(async () => [] as unknown[]),
    evaluate: vi.fn<
      (fn: (arg: string) => unknown, arg: string) => Promise<undefined>
    >(async () => undefined),
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

  it("C3: login が goto(baseUrl) と ID/PW の fill・submit(DOM click) へ委譲する", async () => {
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
    // ログインボタンは type="button"+onclick(requireCheck→form.submit)の特殊構造。
    // page.click は周辺要素の被り/actionability で空振りするため、DOM click を evaluate で発火する。
    expect(f.page.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(String),
    );
  });

  it("C3b: submit の evaluate 関数は対象セレクタ要素の DOM click() を呼ぶ（覆い/actionability に非依存）", async () => {
    const f = makeFakeChromium();
    let evaluatedFn: ((arg: string) => unknown) | undefined;
    let evaluatedArg: string | undefined;
    f.page.evaluate.mockImplementation(
      async (fn: (arg: string) => unknown, arg: string) => {
        evaluatedFn = fn;
        evaluatedArg = arg;
        return undefined;
      },
    );
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "x", password: "y", baseUrl: "https://reg.test" });

    expect(typeof evaluatedFn).toBe("function");
    expect(typeof evaluatedArg).toBe("string");

    // 渡された pageFunction を fake DOM で実行し、対象セレクタ要素の click() が呼ばれることを検証。
    let clicked = false;
    const fakeDoc = {
      querySelector: (s: string) =>
        s === evaluatedArg ? { click: () => (clicked = true) } : null,
    };
    const orig = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = fakeDoc;
    try {
      evaluatedFn!(evaluatedArg!);
    } finally {
      (globalThis as { document?: unknown }).document = orig;
    }
    expect(clicked).toBe(true);
  });

  it("C3c: summarizeRegistryLoginError は name+message を返し、secret を除去する", () => {
    const e = new Error("page.fill: timeout for secret-pw-9999 at #password");
    e.name = "TimeoutError";
    const out = summarizeRegistryLoginError(e, ["the-login-id", "secret-pw-9999"]);
    expect(out).toContain("TimeoutError");
    expect(out).not.toContain("secret-pw-9999"); // secret は除去
    expect(out).toContain("***");
    expect(out.length).toBeLessThanOrEqual(300);
  });

  // 2026-07-17 運用診断の穴: 先頭行のみだと「page.fill: Timeout 30000ms exceeded.」で
  // **どのセレクタで**待ちタイムアウトしたかが journal から読めなかった(実障害で再調査が必要に
  // なった)。Playwright の call log にある最初の "waiting for ..." 行を要約へ含める。
  it("C3e: summarizeRegistryLoginError は call log の waiting for 行(失敗セレクタ)を含める", () => {
    const e = new Error(
      [
        "page.fill: Timeout 30000ms exceeded.",
        "Call log:",
        "  - waiting for locator('#userId')",
        "    - navigated to secret-url",
      ].join("\n"),
    );
    e.name = "TimeoutError";
    const out = summarizeRegistryLoginError(e, ["secret-url"]);
    expect(out).toContain("TimeoutError");
    expect(out).toContain("#userId"); // 失敗セレクタが読める
    expect(out).not.toContain("secret-url"); // secret 除去は全行に効く
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it("C3d: login 失敗ログは baseUrl / login URL を除去する（env の内部エンドポイント非露出・@codex）", async () => {
    const f = makeFakeChromium();
    const secretBase = "https://internal.reg.example";
    // goto が遷移先 URL 込みのメッセージで reject（Playwright の典型）
    f.page.goto.mockRejectedValue(
      new Error(
        `page.goto: net::ERR_CONNECTION_REFUSED at ${secretBase}/TeikyoUketsuke/common/login`,
      ),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const factory = resolveDefaultRegistryBrowserFactory({
        chromiumLoader: f.loader,
      });
      const page = await factory!();
      await expect(
        page.login({ loginId: "id", password: "pw", baseUrl: secretBase }),
      ).rejects.toThrow();
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join(" ");
      expect(logged).not.toContain(secretBase); // 内部 base URL は漏らさない
      expect(logged).toContain("***"); // 除去が実施されている
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("C3f: 「ご利用中の方へ」(二重ログイン)が出たら強制ログインで突破してから loggedIn を待つ", async () => {
    // 2026-07-17 本番実測: 前回セッション残存で login 送信後に確認画面が挟まる。マーカーが
    // 出る=この画面。強制ログインボタンを DOM click で押し、その後 loggedIn を待つ。
    const f = makeFakeChromium();
    const order: string[] = [];
    // マーカー(確認画面)は「出る」ように差し替え。loggedIn は成功。
    f.page.waitForSelector = vi.fn(async (selector: string) => {
      order.push(`wait:${selector}`);
      return {};
    });
    const evaluatedArgs: string[] = [];
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) => {
      evaluatedArgs.push(arg);
      order.push(`click:${arg}`);
      return undefined;
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" });
    // ログインボタン→強制ログインボタンの2回 DOM click(いずれも button.CForwardLong)。
    expect(evaluatedArgs).toEqual(["button.CForwardLong", "button.CForwardLong"]);
    // 確認画面マーカーを待って強制ログインを押し、その「後」に loggedIn を待つ順序。
    const forceIdx = order.indexOf(`wait:${REGISTRY_FORCE_LOGIN_MARKER}`);
    const loggedInIdx = order.indexOf('wait:form[name="logoutForm"]');
    expect(forceIdx).toBeGreaterThanOrEqual(0);
    expect(loggedInIdx).toBeGreaterThan(forceIdx);
    // マーカー検出は hidden input のため state:"attached" 必須(=リグレッションで落ちたら
    // 確認画面を検出できず突破不能になる。この非自明な要件を値で固定する)。
    expect(f.page.waitForSelector).toHaveBeenCalledWith(
      REGISTRY_FORCE_LOGIN_MARKER,
      expect.objectContaining({ state: "attached" }),
    );
    // 突破後は確認画面固有マーカーの消失(detached)を積極確認する(空振り検出)。
    expect(f.page.waitForSelector).toHaveBeenCalledWith(
      REGISTRY_FORCE_LOGIN_MARKER,
      expect.objectContaining({ state: "detached" }),
    );
  });

  it("C3h: 強制ログインを押しても確認画面から抜けない(マーカー残存)なら失敗させる", async () => {
    // 押下が空振り(セレクタ変更/ボタン無効化)でマーカーが消えない場合、detached 待ちが
    // timeout → auth_failed。loggedIn が確認画面にも在るせいで誤って成功扱いになる退行を防ぐ。
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(
      async (selector: string, options?: { state?: string }) => {
        if (selector === REGISTRY_FORCE_LOGIN_MARKER) {
          // attached(検出)は成功、detached(消失)は永遠に来ない=timeout。
          if (options?.state === "detached") throw makeTimeoutError();
          return {};
        }
        return {};
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const factory = resolveDefaultRegistryBrowserFactory({
        chromiumLoader: f.loader,
      });
      const page = await factory!();
      await expect(
        page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
      ).rejects.toThrow(RegistryFetchError);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("C3g: 二重ログインでない(マーカー timeout)なら強制ログインを押さず loggedIn へ進む", async () => {
    // 既定 fake は forceLoginMarker で timeout する(=通常メニュー)。突破 click は起きず、
    // login は解決する(throw しない)。
    const f = makeFakeChromium();
    const evaluatedArgs: string[] = [];
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) => {
      evaluatedArgs.push(arg);
      return undefined;
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).resolves.toBeUndefined();
    // DOM click はログインボタンの1回のみ(強制ログインは押さない)。
    expect(evaluatedArgs).toEqual(["button.CForwardLong"]);
    // loggedIn は待つ。
    expect(f.page.waitForSelector).toHaveBeenCalledWith('form[name="logoutForm"]');
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

  it("C9: searchByLocation は 実サイトの多段UI(所在ラジオ/種別/都道府県select/直接入力/地番家屋)へ委譲→結果行を候補へ変換", async () => {
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
    // 都道府県はプルダウン(selectOption)へ、市区町村以下は直接入力(fill)へ分解して渡す。
    expect(f.page.selectOption).toHaveBeenCalledWith(expect.any(String), "東京都");
    expect(f.page.check).toHaveBeenCalled(); // 直接入力モード
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "千代田区丸の内1");
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "1番"); // 地番・家屋番号(1欄)
    expect(f.page.click).toHaveBeenCalled();
    expect(candidates).toHaveLength(2);
    expect(candidates[0].realEstateNumber).toBe("1234567890123");
    // candidateRef 空は row-index フォールバックで必ず非空。
    expect(candidates[1].candidateRef).not.toBe("");
  });

  it("C9e: 地番・家屋番号は 1 欄に空白区切りで連結し、家屋番号ありは建物種別を選ぶ", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await page.searchByLocation!({
      address: "北海道札幌市中央区北1条",
      lotNumber: "5番",
      buildingNumber: "12",
    });
    expect(f.page.selectOption).toHaveBeenCalledWith(expect.any(String), "北海道");
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "5番 12");
    // 家屋番号ありは種別=建物(#fuShozaiTypeTATEMONO)を選ぶ(@codex P2)。
    expect(f.page.click).toHaveBeenCalledWith("#fuShozaiTypeTATEMONO");
    expect(f.page.click).not.toHaveBeenCalledWith("#fuShozaiTypeTOCHI");
  });

  it("C9f: 家屋番号なし(地番のみ)は種別=土地を選ぶ", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都千代田区丸の内1",
      lotNumber: "1番",
      buildingNumber: null,
    });
    expect(f.page.click).toHaveBeenCalledWith("#fuShozaiTypeTOCHI");
    expect(f.page.click).not.toHaveBeenCalledWith("#fuShozaiTypeTATEMONO");
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
  // CodexP2: login のパスは env（REGISTRY_FETCH_LOGIN_PATH）で上書きできる
  // （サイト改修時に固定値を変えずに即応できるようにする）。
  it("C14: DEFAULT_REGISTRY_LOGIN_PATH は '/' 始まりの相対パス（base に前置する想定）", () => {
    expect(DEFAULT_REGISTRY_LOGIN_PATH.startsWith("/")).toBe(true);
  });

  // 2026-07-17 本番VPSでの実測: form action のパス /TeikyoUketsuke/common/login へ **直接** goto
  // するとセッション未確立で「ページ期限切れ」画面(フォーム無し)が返り、#userId の fill が
  // timeout → auth_failed になる。コンテキストルート /TeikyoUketsuke/ ならログインフォームが
  // 直接表示される(ログイン成功まで実証済み)。期限切れパスへの回帰を値で固定する。
  it("C14b: DEFAULT_REGISTRY_LOGIN_PATH は入口 /TeikyoUketsuke/（直接アクセス可）であり、ページ期限切れになる /common/login ではない", () => {
    expect(DEFAULT_REGISTRY_LOGIN_PATH).toBe("/TeikyoUketsuke/");
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

  it("C17: REGISTRY_FETCH_LOGIN_PATH 未設定なら既定 login path（DEFAULT_REGISTRY_LOGIN_PATH）を使う", async () => {
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

  it("SP: splitAddressForLocationSearch は都道府県と市区町村以下に分解する", () => {
    expect(splitAddressForLocationSearch("東京都千代田区丸の内1-1-1")).toEqual({
      prefecture: "東京都",
      rest: "千代田区丸の内1-1-1",
    });
    expect(splitAddressForLocationSearch("北海道札幌市中央区北1条")).toEqual({
      prefecture: "北海道",
      rest: "札幌市中央区北1条",
    });
    expect(splitAddressForLocationSearch("大阪府大阪市北区")).toEqual({
      prefecture: "大阪府",
      rest: "大阪市北区",
    });
    expect(splitAddressForLocationSearch("神奈川県横浜市西区")).toEqual({
      prefecture: "神奈川県",
      rest: "横浜市西区",
    });
    // @codex P1: 「京都府」は2文字目が「都」= 早期マッチ罠。明示列挙で正しく分解する。
    expect(splitAddressForLocationSearch("京都府京都市中京区河原町通")).toEqual({
      prefecture: "京都府",
      rest: "京都市中京区河原町通",
    });
    // 4文字県(和歌山県/鹿児島県)も .{2,3}県 で受ける。
    expect(splitAddressForLocationSearch("和歌山県和歌山市")).toEqual({
      prefecture: "和歌山県",
      rest: "和歌山市",
    });
  });

  it("SP2: 都道府県が判別できない/空は prefecture=null(全体を所在へ)", () => {
    expect(splitAddressForLocationSearch("丸の内1-1")).toEqual({
      prefecture: null,
      rest: "丸の内1-1",
    });
    expect(splitAddressForLocationSearch("x")).toEqual({
      prefecture: null,
      rest: "x",
    });
    // 先頭空白は trim される。
    expect(splitAddressForLocationSearch("  東京都港区  ")).toEqual({
      prefecture: "東京都",
      rest: "港区",
    });
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
