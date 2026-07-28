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
  extractChibanCandidateRows,
  detectRegistryUnavailablePage,
  classifyRegistryMissingPage,
  resolveLoginFormDetectMs,
  resolveLoginStepDeadline,
  remainingLoginStepMs,
  normalizeChibanForDialog,
  splitAddressForLocationSearch,
  summarizeRegistryLoginError,
} from "../auto-fetch";
import {
  RegistryFetchError,
  REGISTRY_FETCH_ERROR_MESSAGES,
} from "../errors";

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
    waitForFunction: vi.fn(async () => ({})),
    waitForEvent: vi.fn(async () => ({
      createReadStream: async () => Readable.from([Buffer.from("%PDF-1.4 dl")]),
    })),
    $$eval: vi.fn(async () => [] as unknown[]),
    evaluate: vi.fn<
      (fn: (arg: string) => unknown, arg: string) => Promise<unknown>
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

describe("detectRegistryUnavailablePage（時間外/停止ページのブラウザ内判定）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("jikangai(時間外案内)へ誘導された URL は 'closed'(確定時間外)", () => {
    vi.stubGlobal("location", {
      href: "https://reg.test/TeikyoUketsuke/jikangai.html",
    });
    vi.stubGlobal("document", { title: "ご利用時間のお知らせ" });
    expect(detectRegistryUnavailablePage()).toBe("closed");
  });

  it("夜間時間外の 404 ページ(URL 不変・title が404)は 'missing'", () => {
    vi.stubGlobal("location", {
      href: "https://reg.test/TeikyoUketsuke/common/login",
    });
    vi.stubGlobal("document", { title: "404｜ページが見つかりません" });
    expect(detectRegistryUnavailablePage()).toBe("missing");
  });

  it("通常のログイン画面は ''(利用可能)", () => {
    vi.stubGlobal("location", {
      href: "https://reg.test/TeikyoUketsuke/common/login",
    });
    vi.stubGlobal("document", { title: "登記情報提供サービス ログイン" });
    expect(detectRegistryUnavailablePage()).toBe("");
  });

  it("グローバル未定義(非ブラウザ)では ''(誤検出しない)", () => {
    expect(detectRegistryUnavailablePage()).toBe("");
  });

  it("service_hours の利用者向け文言に利用時間を明記する", () => {
    const msg = REGISTRY_FETCH_ERROR_MESSAGES.service_hours;
    expect(msg).toContain("ご利用時間外");
    expect(msg).toContain("平日 8:30〜23:00");
    expect(msg).toContain("土日祝日 8:30〜18:00");
  });

  it("service_unavailable の文言は時間外と断定せず、利用時間を案内する", () => {
    const msg = REGISTRY_FETCH_ERROR_MESSAGES.service_unavailable;
    expect(msg).toContain("接続できません");
    expect(msg).toContain("可能性");
    expect(msg).toContain("平日 8:30〜23:00");
    expect(msg).toContain("土日祝日 8:30〜18:00");
  });
});

describe("classifyRegistryMissingPage（404 検出時の時計による分類・JST）", () => {
  // JST = UTC+9。Date.UTC で「JST の狙い時刻 − 9時間」を組み立てる。
  const jst = (y: number, mo: number, d: number, h: number, mi: number) =>
    new Date(Date.UTC(y, mo - 1, d, h - 9, mi));

  it("平日深夜(23:00 以降)は全日閉局 → service_hours と断定", () => {
    expect(classifyRegistryMissingPage(jst(2026, 7, 22, 23, 30))).toBe(
      "service_hours",
    ); // 水曜 23:30
    expect(classifyRegistryMissingPage(jst(2026, 7, 22, 23, 0))).toBe(
      "service_hours",
    ); // 境界: 23:00 ちょうどは閉局
  });

  it("早朝(8:30 前)は全日閉局 → service_hours と断定", () => {
    expect(classifyRegistryMissingPage(jst(2026, 7, 21, 7, 0))).toBe(
      "service_hours",
    ); // 火曜 7:00
    expect(classifyRegistryMissingPage(jst(2026, 7, 21, 8, 29))).toBe(
      "service_hours",
    ); // 境界: 8:29 は閉局
  });

  it("土日の 18:00 以降は閉局 → service_hours と断定", () => {
    expect(classifyRegistryMissingPage(jst(2026, 7, 25, 19, 0))).toBe(
      "service_hours",
    ); // 土曜 19:00
    expect(classifyRegistryMissingPage(jst(2026, 7, 26, 18, 0))).toBe(
      "service_hours",
    ); // 日曜 18:00 ちょうど
  });

  it("平日日中は営業中の可能性 → service_unavailable(断定しない)", () => {
    expect(classifyRegistryMissingPage(jst(2026, 7, 22, 10, 0))).toBe(
      "service_unavailable",
    ); // 水曜 10:00(設定ミス/サイト停止の可能性)
    expect(classifyRegistryMissingPage(jst(2026, 7, 21, 8, 30))).toBe(
      "service_unavailable",
    ); // 境界: 8:30 ちょうどは開局
  });

  it("祝日夜(曜日は平日・18〜23時)は判別不能 → service_unavailable(可能性として案内)", () => {
    // 2026-07-20(海の日・月曜) 21:41 JST = 実際に本番で観測したケース
    expect(classifyRegistryMissingPage(jst(2026, 7, 20, 21, 41))).toBe(
      "service_unavailable",
    );
  });

  it("土曜日中は営業中の可能性 → service_unavailable", () => {
    expect(classifyRegistryMissingPage(jst(2026, 7, 25, 10, 0))).toBe(
      "service_unavailable",
    );
  });
});

describe("resolveLoginFormDetectMs（フォーム出現待ちの予算導出・@codex P2）", () => {
  it("予算未設定/不正は既定 15000", () => {
    expect(resolveLoginFormDetectMs(undefined)).toBe(15000);
    expect(resolveLoginFormDetectMs(Number.NaN)).toBe(15000);
    expect(resolveLoginFormDetectMs(0)).toBe(15000);
    expect(resolveLoginFormDetectMs(-5)).toBe(15000);
  });

  it("予算ありは半分(上限15000)=launch/goto に残り半分を確保", () => {
    expect(resolveLoginFormDetectMs(30000)).toBe(15000);
    expect(resolveLoginFormDetectMs(60000)).toBe(15000);
    expect(resolveLoginFormDetectMs(10000)).toBe(5000);
  });

  it("極小予算は下限1000にクランプ(設定ミス域でも負値/0にしない)", () => {
    expect(resolveLoginFormDetectMs(1500)).toBe(1000);
    expect(resolveLoginFormDetectMs(100)).toBe(1000);
  });
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

  it("C3s: 利用時間外(jikangai へ誘導)なら service_hours で停止し auth_failed にしない", async () => {
    const f = makeFakeChromium();
    // login の最初の evaluate(利用不可判定・arg="")を「時間外案内(closed)」に。他は undefined。
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "" ? "closed" : undefined,
    );
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "service_hours" });
    // 時間外検出は fill の前=ID/PW を入力しに行かない(資格情報を疑わせない)。
    expect(f.page.fill).not.toHaveBeenCalled();
  });

  it("C3t: 送信後に時間外へ切替(締切レース)でも、着地待ち失敗時に URL 再確認で service_hours にする", async () => {
    const f = makeFakeChromium();
    // 利用不可判定(arg=""): 1回目(初回goto直後)=""(利用可)、2回目(catch再確認)="closed"。
    let jikangaiChecks = 0;
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "" ? (++jikangaiChecks >= 2 ? "closed" : "") : undefined,
    );
    // 送信後の着地待ち(グループセレクタ=menuClick を含む)で timeout させる。他は成功。
    f.page.waitForSelector = vi.fn(async (sel: string) => {
      if (sel.includes("menuClick")) throw makeTimeoutError();
      return {};
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "service_hours" });
  });

  it("C3u: 夜間の時間外(サイト全体が404ページ・URLは不変)でも時間外系に分類し auth_failed にしない", async () => {
    const f = makeFakeChromium();
    // 実ブラウザ相当: 渡された判定関数を実際に実行する。グローバルは夜間時間外の実挙動
    // (URL はログインURLのまま・title が 404)を模す(2026-07-20 本番probe で採取)。
    vi.stubGlobal("location", {
      href: "https://reg.test/TeikyoUketsuke/common/login",
    });
    vi.stubGlobal("document", { title: "404｜ページが見つかりません" });
    try {
      f.page.evaluate = vi.fn(
        async (fn: (arg: string) => unknown, arg: string) => fn(arg),
      );
      const factory = resolveDefaultRegistryBrowserFactory({
        chromiumLoader: f.loader,
      });
      const page = await factory!();
      // 分類はテスト実行時刻の実時計に依存する(確実な閉局帯=service_hours/それ以外=
      // service_unavailable)。どちらであっても auth_failed でない=資格情報を疑わせない
      // ことが本テストの契約。時計の分岐自体は classifyRegistryMissingPage 単体で固定検証。
      const err = await page
        .login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RegistryFetchError);
      expect(["service_hours", "service_unavailable"]).toContain(
        (err as RegistryFetchError).code,
      );
      // 404 検出は fill の前=ID/PW を入力しに行かない(資格情報を疑わせない)。
      expect(f.page.fill).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("C3v: ログインフォーム不在(出現待ちtimeout)は時間外系に分類し auth_failed にしない(閉局時の案内ページ対策)", async () => {
    const f = makeFakeChromium();
    // 閉局時にアプリの入口URL(www側)が返す「ご利用中の皆様へ」案内ページ(HTTP200・
    // jikangai でも 404 でもない・#userId 無し・2026-07-21 02:30 本番probeで採取)を模す:
    // 利用不可判定は ""(すり抜け)・#userId の出現待ち(専用短timeout)が timeout する。
    // ⚠fill の既定 timeout でなく専用 waitForSelector で検出する(@codex P1: 主タイムアウト
    // REGISTRY_FETCH_TIMEOUT_MS と同値の fill 待ちでは provider 全体タイマーが先に切れる)。
    f.page.waitForSelector = vi.fn(async (sel: string) => {
      if (sel.includes("userId")) throw makeTimeoutError();
      if (sel === REGISTRY_FORCE_LOGIN_MARKER) throw makeTimeoutError();
      return {};
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    // 分類は実時計依存(確実閉局帯=service_hours/それ以外=service_unavailable)。
    // どちらでも auth_failed でない=資格情報を疑わせないことが契約(時計分岐は
    // classifyRegistryMissingPage 単体で固定検証済み)。
    const err = await page
      .login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryFetchError);
    expect(["service_hours", "service_unavailable"]).toContain(
      (err as RegistryFetchError).code,
    );
    // フォーム不在なら資格情報を入力しに行かない(fill 未呼び出し)。
    expect(f.page.fill).not.toHaveBeenCalled();
  });

  it("C3x: REGISTRY_FETCH_TIMEOUT_MS 設定時、フォーム出現待ちは予算由来の専用timeoutで呼ばれる(@codex P1/P2)", async () => {
    process.env.REGISTRY_FETCH_TIMEOUT_MS = "8000";
    const f = makeFakeChromium();
    const calls: Array<{ sel: string; opts: unknown }> = [];
    f.page.waitForSelector = vi.fn(async (sel: string, opts?: unknown) => {
      calls.push({ sel, opts });
      if (sel === REGISTRY_FORCE_LOGIN_MARKER) throw makeTimeoutError();
      return {};
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" });
    // フォーム出現待ちは全体予算8000の半分=4000で呼ばれる(全体タイマーより先に判定が走る)。
    const formWait = calls.find((c) => c.sel.includes("userId"));
    expect(formWait?.opts).toMatchObject({ timeout: 4000 });
  });

  it("C3w: フォームの fill が非timeoutで失敗した場合は従来どおり auth_failed", async () => {
    const f = makeFakeChromium();
    f.page.fill = vi.fn(async () => {
      throw new Error("element detached");
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "auth_failed" });
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
    // 先頭の jikangai 判定 evaluate(arg="")は除外する。
    expect(evaluatedArgs.filter((a) => a !== "")).toEqual([
      "button.CForwardLong",
      "button.CForwardLong",
    ]);
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
    // 確認画面判定の前に「確認画面 or 通常メニュー」着地をグループセレクタで待つ
    // (5秒固定でなくログイン全体 timeout 内で終端画面を確定=応答遅延の吸収・@codex)。
    const groupWaited = (
      f.page.waitForSelector as unknown as {
        mock: { calls: Array<[string, { state?: string }?]> };
      }
    ).mock.calls.some(
      ([sel, opt]) =>
        typeof sel === "string" &&
        sel.includes(REGISTRY_FORCE_LOGIN_MARKER) &&
        sel.includes("menuClick('FUDOSAN')") &&
        opt?.state === "attached",
    );
    expect(groupWaited).toBe(true);
    // 強制ログインボタン(button.CForwardLong)は click 前に waitForSelector で待つ
    // (確認画面パース途中の空振り race を防ぐ)。login と force で計2回待つ(=force 側の
    // ボタン待ちが消えると1回に落ちて検知できる・@codex 指摘)。
    const buttonWaits = (
      f.page.waitForSelector as unknown as {
        mock: { calls: Array<[string, unknown?]> };
      }
    ).mock.calls.filter(([sel]) => sel === "button.CForwardLong").length;
    expect(buttonWaits).toBe(2);
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
    // DOM click はログインボタンの1回のみ(強制ログインは押さない)。jikangai 判定(arg="")は除外。
    expect(evaluatedArgs.filter((a) => a !== "")).toEqual(["button.CForwardLong"]);
    // loggedIn は待つ。送信後の待機は明示 timeout を持つ (総点検 2026-07-27:
    // 無指定だと page 既定 = provider 全体予算と同値になり、全体タイマーが先に
    // 切れて auth_failed の分類に到達できず、常に「タイムアウト」表示になる)。
    expect(f.page.waitForSelector).toHaveBeenCalledWith(
      'form[name="logoutForm"]',
      { timeout: expect.any(Number) },
    );
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

  it("C9: searchByLocation は 不動産請求遷移→所在/種別/都道府県/直接入力/地番→地番ダイアログ検索→候補抽出→キャンセル", async () => {
    const f = makeFakeChromium();
    const calls: string[] = [];
    f.page.click = vi.fn(async (s: string) => {
      calls.push("click:" + s);
    });
    f.page.fill = vi.fn(async (s: string) => {
      calls.push("fill:" + s);
    });
    f.page.selectOption = vi.fn(async (s: string) => {
      calls.push("select:" + s);
      return [];
    });
    f.page.check = vi.fn(async (s: string) => {
      calls.push("check:" + s);
    });
    f.page.waitForSelector = vi.fn(async (s: string) => {
      calls.push("wait:" + s);
      return {};
    });
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) => {
      calls.push("eval:" + arg);
      return undefined;
    });
    f.page.$$eval = vi.fn(async () => [
      { candidateRef: "cbnDlgChibanChk_1", lotNumber: "１－１" },
      { candidateRef: "cbnDlgChibanChk_2", lotNumber: "１－２" },
    ]);
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    const candidates = await page.searchByLocation!({
      address: "東京都千代田区丸の内一丁目",
      lotNumber: "1",
      buildingNumber: null,
    });
    // 不動産請求への遷移(DOM click)を経由。
    expect(calls).toContain("eval:a[href*=\"menuClick('FUDOSAN')\"]");
    expect(calls).toContain("click:#fuSeikyuMethodSHOZAI");
    expect(calls).toContain("select:#fuTodofukenShozai");
    expect(calls).toContain("check:#fuShozaiChokusetuNyuryoku");
    expect(calls).toContain("click:#fuChibanKaokuIchiran"); // 地番一覧ダイアログを開く
    expect(calls).toContain("click:#cbnDlgChibanSearch"); // ダイアログ検索
    // 非同期候補ロードを待つ。
    expect(calls).toContain("wait:#cbnDlgChibanCheckTbl input[type=checkbox]");
    // 課金しない: 確定は押さずキャンセルで閉じる。
    expect(calls).toContain("eval:#cbnDlgBtnCancel");
    expect(calls).not.toContain("click:#cbnDlgBtnOk");
    expect(calls).not.toContain("click:#myPageSeikyu");
    // 候補整形(地番=行の値、所在=入力、不動産番号は所在検索段では得られず null)。
    expect(candidates).toEqual([
      { candidateRef: "cbnDlgChibanChk_1", address: "東京都千代田区丸の内一丁目", lotNumber: "１－１", buildingNumber: null, realEstateNumber: null },
      { candidateRef: "cbnDlgChibanChk_2", address: "東京都千代田区丸の内一丁目", lotNumber: "１－２", buildingNumber: null, realEstateNumber: null },
    ]);
  });

  it("C9e: 家屋番号ありは種別=建物を選ぶ", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    f.page.$$eval = vi.fn(async () => [
      { candidateRef: "cbnDlgChibanChk_1", lotNumber: "１２３番" },
    ]);
    const candidates = await page.searchByLocation!({
      address: "北海道札幌市中央区北1条",
      lotNumber: "5番",
      buildingNumber: "12",
    });
    expect(f.page.selectOption).toHaveBeenCalledWith(expect.any(String), "北海道");
    // 家屋番号ありは種別=建物(#fuShozaiTypeTATEMONO)を選ぶ。
    expect(f.page.click).toHaveBeenCalledWith("#fuShozaiTypeTATEMONO");
    expect(f.page.click).not.toHaveBeenCalledWith("#fuShozaiTypeTOCHI");
    // @codex P1: 建物は家屋番号("12")で検索する(地番"5番"ではない)。
    expect(f.page.fill).toHaveBeenCalledWith("#fuChibanKaoku", "12");
    expect(f.page.fill).toHaveBeenCalledWith("#cbnDlgSearchChibanStart", "12");
    expect(f.page.fill).not.toHaveBeenCalledWith("#fuChibanKaoku", "5番");
    // @codex P1: 返す候補は行の番号値を家屋番号欄へ(地番欄は null)。
    expect(candidates[0]).toMatchObject({ buildingNumber: "１２３番", lotNumber: null });
  });

  it("C9n: normalizeChibanForDialog は登記表記を数字/ハイフン形式へ正規化する(@codex P1)", () => {
    expect(normalizeChibanForDialog("1番1")).toBe("1-1");
    expect(normalizeChibanForDialog("1937番31")).toBe("1937-31");
    expect(normalizeChibanForDialog("1番2の3")).toBe("1-2-3"); // 「の」区切り保持(@codex P2)
    expect(normalizeChibanForDialog("5番")).toBe("5");
    expect(normalizeChibanForDialog("１－１")).toBe("1-1"); // 全角数字＋全角ハイフン
    expect(normalizeChibanForDialog("1-2-3")).toBe("1-2-3");
    expect(normalizeChibanForDialog("あ番")).toBe(""); // 数字なし→空
  });

  it("C9m: 「1番1」表記の地番はダイアログの数字欄へ「1-1」で入れる(@codex P1)", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都千代田区丸の内一丁目",
      lotNumber: "1番1",
      buildingNumber: null,
    });
    // 数字専用のダイアログ範囲欄には正規化後の「1-1」を入れる(生の「1番1」ではない)。
    expect(f.page.fill).toHaveBeenCalledWith("#cbnDlgSearchChibanStart", "1-1");
    expect(f.page.fill).not.toHaveBeenCalledWith("#cbnDlgSearchChibanStart", "1番1");
  });

  it("C9p: 複数ページの候補を次ページボタンで全て集める(@codex P1)", async () => {
    const f = makeFakeChromium();
    // $$eval: 1回目=1ページ目、2回目=2ページ目。
    f.page.$$eval = vi
      .fn()
      .mockResolvedValueOnce([
        { candidateRef: "chk_1", lotNumber: "１－１" },
        { candidateRef: "chk_2", lotNumber: "１－２" },
      ])
      .mockResolvedValueOnce([{ candidateRef: "chk_3", lotNumber: "１－３" }]);
    // 次ページ有無(evaluate(#cbnDlgBtnPageNext)): 1ページ目後 true、2ページ目後 false。
    let nextChecks = 0;
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "#cbnDlgBtnPageNext" ? nextChecks++ === 0 : undefined,
    );
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    const candidates = await page.searchByLocation!({
      address: "東京都千代田区丸の内一丁目",
      lotNumber: "1",
      buildingNumber: null,
    });
    // 2ページ分を重複排除して全件返す。
    expect(candidates.map((c) => c.candidateRef)).toEqual(["chk_1", "chk_2", "chk_3"]);
    expect(f.page.$$eval).toHaveBeenCalledTimes(2);
    // 次ページボタンを1回押す(通常ボタン=page.click)。
    expect(f.page.click).toHaveBeenCalledWith("#cbnDlgBtnPageNext");
    // @codex P1: 単純な checkbox attached 待ちでなく「ページが実際に切り替わる」まで待つ
    // (waitForFunction)。旧ページ残存 checkbox で即 resolve して1ページ目のみ返す退行を防ぐ。
    expect(f.page.waitForFunction).toHaveBeenCalledTimes(1);
  });

  it("C9q: ページ切替待ち(waitForFunction)が timeout したら以降を諦め既取得分を返す(退行なし・@codex P1)", async () => {
    const f = makeFakeChromium();
    f.page.$$eval = vi
      .fn()
      .mockResolvedValueOnce([{ candidateRef: "chk_1", lotNumber: "１－１" }]);
    // 次ページは常に有効を返すが、ページ切替待ちが timeout → 1ページ目で確定。
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "#cbnDlgBtnPageNext" ? true : undefined,
    );
    f.page.waitForFunction = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    const candidates = await page.searchByLocation!({
      address: "東京都千代田区丸の内一丁目",
      lotNumber: "1",
      buildingNumber: null,
    });
    expect(candidates.map((c) => c.candidateRef)).toEqual(["chk_1"]);
  });

  it("C9g: 検索が0件(checkbox 無し)でロード完了なら空配列を返す(timeout にしない・@codex P2)", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (s: string) => {
      if (s.includes("input[type=checkbox]")) throw makeTimeoutError();
      return {};
    });
    // ロード完了(「データ取得中」が消えた)を模す → 0件として [] を返す。
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "#cbnDlgChibanCheckTbl" ? true : undefined,
    );
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    const candidates = await page.searchByLocation!({
      address: "東京都千代田区丸の内一丁目",
      lotNumber: "999",
      buildingNumber: null,
    });
    expect(candidates).toEqual([]);
  });

  it("C9h: checkbox 無し且つロード未完(データ取得中のまま)は timeout(0件と区別・@codex P2)", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (s: string) => {
      if (s.includes("input[type=checkbox]")) throw makeTimeoutError();
      return {};
    });
    // まだロード中(「データ取得中」)を模す → timeout。
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "#cbnDlgChibanCheckTbl" ? false : undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
      const page = await factory!();
      await expect(
        page.searchByLocation!({ address: "東京都千代田区丸の内一丁目", lotNumber: "1", buildingNumber: null }),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      warn.mockRestore();
    }
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

  it("C10: 候補ロード待ち(#cbnDlgChibanCheckTbl checkbox)の timeout は timeout に分類し PII を出さない", async () => {
    const f = makeFakeChromium();
    // セットアップの waitForSelector は成功、結果 checkbox 待ちだけ timeout。
    f.page.waitForSelector = vi.fn(async (s: string) => {
      if (s.includes("input[type=checkbox]")) {
        const e = new Error("Timeout 30000ms exceeded for 東京都千代田区丸の内");
        (e as { name?: string }).name = "TimeoutError";
        throw e;
      }
      return {};
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
      const page = await factory!();
      await expect(
        page.searchByLocation!({ address: "東京都千代田区丸の内一丁目", lotNumber: "1", buildingNumber: null }),
      ).rejects.toMatchObject({ code: "timeout" });
      const logged = warn.mock.calls.map((c) => c.join(" ")).join(" ");
      expect(logged).toContain("[registry-search]");
      expect(logged).not.toContain("丸の内"); // 所在(PII)を出さない
    } finally {
      warn.mockRestore();
    }
  });

  it("C11: extractChibanCandidateRows は checkbox 行を candidateRef=地番へ変換し非候補行を除外", () => {
    // hasCheckbox=false(ヘッダ等)や地番テキスト無しは除外。candidateRef は checkbox id ではなく
    // **地番テキスト**(ページ跨ぎに安定・一意)。
    const trWith = (hasCheckbox: boolean, lot: string): Element =>
      ({
        querySelector: (sel: string) => {
          if (sel.includes("checkbox")) return hasCheckbox ? {} : null;
          if (sel.includes("cbnDlgChibanDt")) return lot ? { textContent: lot } : null;
          return null;
        },
      }) as unknown as Element;
    const out = extractChibanCandidateRows([
      trWith(true, "１－１"),
      trWith(true, "１－２"),
      trWith(false, "ヘッダ"), // checkbox 無し→除外
      trWith(true, ""), // 地番無し→除外
    ]);
    expect(out).toEqual([
      { candidateRef: "１－１", lotNumber: "１－１" },
      { candidateRef: "１－２", lotNumber: "１－２" },
    ]);
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

describe("ログイン送信後の待機は全体予算より必ず先に切れる (総点検 2026-07-27)", () => {
  // ⚠これが崩れると、資格情報の誤り・アカウントロック・セレクタドリフトなど
  // **送信後の失敗が必ず「謄本取得サービスがタイムアウトしました」(504)** になる。
  // 運用者は「サイトが重いだけ」と読んで資格情報を疑わず、復旧できないまま
  // 再試行を繰り返す。分類 (auth_failed=502) に到達させるのが目的。

  it("分類の余裕(2秒)だけ手前に共有デッドラインを置く", () => {
    // 各段に予算の一定割合を配る方式にはしない: 送信後の待機は5段あるので
    // 合計で予算を超えるうえ、1段だけ正当に遅いケースで成功するはずの
    // ログインを auth_failed に化けさせる (内部レビュー指摘)。
    expect(resolveLoginStepDeadline(1_000_000, 30_000)).toBe(1_028_000);
    expect(resolveLoginStepDeadline(1_000_000, 8_000)).toBe(1_006_000);
  });

  it("どんな予算でも内側の期限は外側より必ず短い (@codex #331 R1)", () => {
    // ⚠余裕の確保に下限を置くと、小さい予算で内側が外側を追い越し、
    // 「常に timeout 表示」がそのまま残る。旧実装の max(1000, budget-2000) では
    // budget=500 → 内側 1000ms > 外側 500ms で必ず外側が先に発火していた。
    for (const budget of [
      1, 2, 10, 100, 500, 999, 1_000, 1_001, 2_000, 2_999, 3_000, 8_000, 30_000,
      120_000,
    ]) {
      const deadline = resolveLoginStepDeadline(0, budget)!;
      expect(deadline).not.toBeNull();
      // 内側の期限 < 外側のタイマー
      expect(deadline).toBeLessThan(budget);
      expect(deadline).toBeGreaterThanOrEqual(0);
    }
  });

  it("極小予算では期限を 0 まで縮め、即座に分類へ回す", () => {
    // 待てないほど短い予算では「待つ」より「分類して正しい原因を出す」が優先。
    expect(resolveLoginStepDeadline(0, 1)).toBe(0);
    expect(remainingLoginStepMs(resolveLoginStepDeadline(0, 1), 0)).toBe(1);
    // 500ms 予算: 余裕は比例縮小 (250ms) → 期限 250ms < 外側 500ms
    expect(resolveLoginStepDeadline(0, 500)).toBe(250);
  });

  it("余裕は予算に比例して縮む (十分な予算では 2 秒を確保)", () => {
    expect(30_000 - resolveLoginStepDeadline(0, 30_000)!).toBe(2_000);
    expect(8_000 - resolveLoginStepDeadline(0, 8_000)!).toBe(2_000);
    // 予算 3 秒なら余裕は 1.5 秒 (2 秒を取ると外側を追い越すため)
    expect(3_000 - resolveLoginStepDeadline(0, 3_000)!).toBe(1_500);
    expect(1_000 - resolveLoginStepDeadline(0, 1_000)!).toBe(500);
  });

  it("残り予算をほぼ全部使ってよい (痩せた割り当てで正当な遅延を殺さない)", () => {
    const deadline = resolveLoginStepDeadline(0, 30_000)!;
    // 送信までに5秒使っていても、残り23秒を1段の待機に使える
    expect(remainingLoginStepMs(deadline, 5_000)).toBe(23_000);
  });

  it("5段すべてが同じデッドラインを共有し、合計が予算を超えない", () => {
    const budget = 30_000;
    const deadline = resolveLoginStepDeadline(0, budget)!;
    let clock = 0;
    let total = 0;
    for (let step = 0; step < 5; step++) {
      const allowed = remainingLoginStepMs(deadline, clock);
      total += allowed;
      clock += allowed; // 各段が上限まで使い切った最悪ケース
    }
    // 最悪ケースでも「予算 - 分類の余裕」で止まる (下限1秒ぶんの誤差を許容)
    expect(clock).toBeLessThanOrEqual(budget);
    expect(total).toBeLessThanOrEqual(budget);
    // 1段目に大半を渡している = 割り当てで痩せていない
    expect(remainingLoginStepMs(deadline, 0)).toBe(28_000);
  });

  it("デッドライン超過後は 1ms (0や負値を渡さない・合計も膨らませない)", () => {
    const deadline = resolveLoginStepDeadline(0, 30_000)!;
    expect(remainingLoginStepMs(deadline, 999_999)).toBe(1);
  });

  it("予算未設定なら従来どおり (Playwright 既定と同値・挙動不変)", () => {
    expect(resolveLoginStepDeadline(1_000, undefined)).toBeNull();
    expect(resolveLoginStepDeadline(1_000, 0)).toBeNull();
    expect(resolveLoginStepDeadline(1_000, Number.NaN)).toBeNull();
    expect(remainingLoginStepMs(null, 12_345)).toBe(30_000);
  });

  it("login 内の待機はすべて明示 timeout を持つ (page 既定に頼らない)", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/lib/registry-fetch/auto-fetch.ts", "utf8");
    const loginBody = src.slice(
      src.indexOf("async login(input)"),
      src.indexOf("async searchByRealEstateNumber"),
    );
    const waits = loginBody.match(/waitForSelector\(/g) ?? [];
    // フォーム出現 / ログインボタン / 着地 / 確認画面判定 / 強制ログインボタン /
    // 確認画面の消失 / ログイン成功要素
    expect(waits.length).toBe(7);
    // 全ての待機が timeout を伴うこと (page 既定 = 全体予算に落ちない)
    const timeouts = loginBody.match(/timeout:/g) ?? [];
    expect(timeouts.length).toBe(waits.length);
  });

  it("送信後の待機に渡る実値が全体予算より小さい (予算そのままに戻らない)", async () => {
    // ⚠expect.any(Number) では、全体予算をそのまま渡す退行を検出できない
    // (内部レビュー指摘)。実値を突き合わせる。
    process.env.REGISTRY_FETCH_TIMEOUT_MS = "30000";
    const f = makeFakeChromium();
    const calls: Array<{ sel: string; opts: { timeout?: number } | undefined }> = [];
    f.page.waitForSelector = vi.fn(async (sel: string, opts?: unknown) => {
      calls.push({ sel, opts: opts as { timeout?: number } | undefined });
      if (sel === REGISTRY_FORCE_LOGIN_MARKER) throw makeTimeoutError();
      return {};
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" });

    // 着地待ち (グループセレクタ) と loggedIn の実値を確認
    const landing = calls.find((c) => c.sel.includes(","));
    const loggedIn = calls.find((c) => c.sel === 'form[name="logoutForm"]');
    for (const c of [landing, loggedIn]) {
      expect(c?.opts?.timeout).toBeDefined();
      // 全体予算(30000)より小さい = 分類が先に走れる
      expect(c!.opts!.timeout!).toBeLessThan(30_000);
      // 分類の余裕(2秒)を引いた上限以下
      expect(c!.opts!.timeout!).toBeLessThanOrEqual(28_000);
    }
    delete process.env.REGISTRY_FETCH_TIMEOUT_MS;
  });
});
