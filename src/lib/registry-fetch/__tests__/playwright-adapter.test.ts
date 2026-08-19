import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
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
  registryRowMatchesChiban,
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

/**
 * 所在選択ダイアログ(B案)の既定の応答。
 *
 * ⚠テストが page.evaluate を差し替えるときは**必ずここへ委譲する**。
 * 委譲を忘れると所在が確定できず location_rejected になり、そのテストが
 * 見たかった地番ダイアログ以降に到達しない（原因が分かりにくい形で落ちる）。
 */
function shozaiDialogDefault(arg: string): unknown {
  if (arg === '#kuikiDialogArea td[id^="GKuiki"]') return [];
  if (arg === ".ui-dialog-buttonpane button") return true;
  // 都道府県は「表示名 → コード」を引いてから選ぶ(実サイトの option 値はコード)。
  // 引数は "<select のセレクタ>|<表示名>" 形式。
  if (arg.startsWith("#fuTodofukenShozai|")) return "13";
  return undefined;
}

/**
 * その `waitForFunction` が「所在選択ダイアログの待ち」かどうか。
 *
 * ⚠候補一覧の**ページ送りの待ち**と区別するために要る。ダイアログ方式(B案)で
 * 待ちが増えたため、`waitForFunction` を全部まとめて数えたり全部 timeout に
 * させたりすると、ページ送りを見たいテストが**別の待ちに反応して**落ちる。
 */
function isShozaiDialogWait(arg: unknown): boolean {
  if (typeof arg !== "string") return false;
  return (
    arg.includes("fuShozaiSentaku") ||
    arg.includes("kuikiDialogArea") ||
    arg.includes("GKuikiDialog") ||
    arg.includes("fuChibanKuiki")
  );
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
    waitForFunction: vi.fn(async (_fn?: unknown, _arg?: unknown) => ({})),
    waitForEvent: vi.fn(async () => ({
      createReadStream: async () => Readable.from([Buffer.from("%PDF-1.4 dl")]),
    })),
    $$eval: vi.fn(async () => [] as unknown[]),
    // 既定の evaluate。所在選択ダイアログ(B案)の最小の振る舞いを持たせる:
    //  - 区域の一覧は空 = 都道府県だけで確定できる地域を模す
    //  - ダイアログの「確定」は押せる状態
    // ⚠ここを undefined のままにすると所在が確定できず location_rejected になり、
    // 地番ダイアログ以降の既存テストが丸ごと落ちる。
    evaluate: vi.fn<
      (fn: (arg: string) => unknown, arg: string) => Promise<unknown>
    >(async (_fn: (arg: string) => unknown, arg: string) =>
      shozaiDialogDefault(arg),
    ),
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
    // fill には共有デッドライン由来の timeout を渡す (@codex #331 R1)
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "the-id", {
      timeout: expect.any(Number),
    });
    expect(f.page.fill).toHaveBeenCalledWith(expect.any(String), "the-pw", {
      timeout: expect.any(Number),
    });
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

  it("送信後の待機が予算切れなら timeout (遅いだけを資格情報の誤りにしない・@codex #331 R1)", async () => {
    // ⚠内側デッドラインを入れた副作用: 「サイトが遅くて着地マーカーが出ない」も
    // catch へ落ちるので、無条件に auth_failed にすると**一時的な遅延を
    // 資格情報の誤りとして報告**してしまう。これは「常にタイムアウト表示」の
    // 裏返しで、やはり運用者を誤った対処へ導く。
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (sel: string) => {
      // 着地マーカーが出ない (グループセレクタ待ちが timeout)
      if (sel.includes(",")) throw makeTimeoutError();
      return {};
    });
    // ログイン画面へ戻っていない = 弾かれた証拠が無い
    f.page.evaluate = vi.fn(async () => false);
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("goto が予算を食ってもフォーム出現待ちが外側タイマーを追い越さない (@codex #331 R1)", async () => {
    // ⚠固定 15 秒のままだと、30 秒予算のうち goto が 16 秒使った場面で残り 12 秒
    // しか無いのに 15 秒待とうとし、外側タイマーが先に発火する。すると
    // 「フォームが現れない = 閉局/接続不可」の分類に到達できず generic timeout に化ける。
    process.env.REGISTRY_FETCH_TIMEOUT_MS = "30000";
    const f = makeFakeChromium();
    // 疑似時計: goto で 16 秒進める
    let clock = 0;
    f.page.goto = vi.fn(async (_url: string) => {
      clock += 16_000;
      return undefined;
    });
    const calls: Array<{ sel: string; opts: { timeout?: number } | undefined }> = [];
    f.page.waitForSelector = vi.fn(async (sel: string, opts?: unknown) => {
      calls.push({ sel, opts: opts as { timeout?: number } | undefined });
      if (sel === REGISTRY_FORCE_LOGIN_MARKER) throw makeTimeoutError();
      return {};
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
      now: () => clock,
    });
    const page = await factory!();
    await page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" });

    const formWait = calls.find((c) => c.sel.includes("userId"));
    expect(formWait?.opts?.timeout).toBeDefined();
    // 残り予算 (28,000 - 16,000 = 12,000) を超えない
    expect(formWait!.opts!.timeout!).toBeLessThanOrEqual(12_000);
    // 固定 15 秒に戻っていない
    expect(formWait!.opts!.timeout!).toBeLessThan(15_000);
    delete process.env.REGISTRY_FETCH_TIMEOUT_MS;
  });

  it("送信前の timeout は auth_failed にしない (@codex #331 R1)", async () => {
    // ⚠送信前 (goto / fill / ログインボタン待ち) はログインフォームが出ているのが
    // 正常なので、フォームの有無では判別できない。放置すると「ログインページが
    // 遅い」が「資格情報の誤り」として出る。
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (sel: string) => {
      // ログインボタン待ちで timeout (= まだ送信していない)
      if (sel === "button.CForwardLong") throw makeTimeoutError();
      return {};
    });
    // ログインフォームは在る (送信前なので当然)
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: unknown) =>
      arg === "" ? "" : true,
    );
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("ログイン画面へ戻っていれば auth_failed (弾かれた証拠を積極検出する)", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (sel: string) => {
      if (sel.includes(",")) throw makeTimeoutError();
      return {};
    });
    // detectRegistryUnavailablePage は "" (閉局でない)、#userId は在る
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: unknown) =>
      arg === "" ? "" : true,
    );
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("時間外の判定は timeout より優先される (既存の分類を壊さない)", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (sel: string) => {
      if (sel.includes(",")) throw makeTimeoutError();
      return {};
    });
    // 送信後に閉局へ切り替わったケース
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: unknown) =>
      arg === "" ? "closed" : false,
    );
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).rejects.toMatchObject({ code: "service_hours" });
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
    expect(evaluatedArgs.filter((a) => a !== "" && !a.includes("|"))).toEqual([
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
      // ⚠分類まで固定する (@codex #331 R1)。ここで詰まるのは前回セッションが
      // 残っている問題なので、timeout(= 再試行を促す) ではなく auth_failed
      // (= ログインセッションを調べる) が正しい。共有デッドライン導入で
      // 内側の待機が先に切れるようになったため、明示的に固定しておく。
      await expect(
        page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
      ).rejects.toMatchObject({ code: "auth_failed" });
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
      return shozaiDialogDefault(arg);
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
    ).resolves.toBeUndefined();
    // DOM click はログインボタンの1回のみ(強制ログインは押さない)。
    // jikangai 判定(arg="") と送信前の印付け(arg に "|" を含む)は除外。
    expect(evaluatedArgs.filter((a) => a !== "" && !a.includes("|"))).toEqual(["button.CForwardLong"]);
    // loggedIn は待つ。送信後の待機は明示 timeout を持つ (総点検 2026-07-27:
    // 無指定だと page 既定 = provider 全体予算と同値になり、全体タイマーが先に
    // 切れて auth_failed の分類に到達できず、常に「タイムアウト」表示になる)。
    expect(f.page.waitForSelector).toHaveBeenCalledWith(
      'form[name="logoutForm"]',
      { timeout: expect.any(Number) },
    );
  });

  it("C4: ⚠番号取得は段階②未配線のうち、実サイトに触れる前に止める（カートを汚さない）", async () => {
    // 実フローは「番号入力 → **確定** → (マイページで)請求[課金] → PDF」で、確定から先が未実装。
    // 「確定」は無料だが**カートに `未請求` の行を実際に作る**ため、ここで進めると PDF に
    // 到達できないまま外部に行が残り、再試行のたびにゴミ行が積み上がる（@codex #344 P1）。
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();

    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toMatchObject({ code: "provider_error" });

    // ★本質: **一切ページを操作していない**こと（番号も送っていない）。
    expect(f.page.fill).not.toHaveBeenCalled();
    expect(f.page.click).not.toHaveBeenCalled();
    expect(f.page.waitForSelector).not.toHaveBeenCalled();
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
      return shozaiDialogDefault(arg);
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
    // ⚠所在は**ダイアログで確定**する（直接入力は使わない）。所在欄に住所を
    // 打ち込む方式は実機で「請求できない所在です」で止まる。
    expect(calls).toContain("click:#fuShozaiSentaku");
    expect(calls).not.toContain("check:#fuShozaiChokusetuNyuryoku");
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
    // ⚠都道府県は**表示名ではなくコード**で選ぶ(実サイトの option 値はコード)。
    // 表示名をそのまま渡すと一致せず選べず、所在選択ボタンが有効にならない。
    // fake は「表示名 → コード」の引き当てを shozaiDialogDefault で模している。
    expect(f.page.selectOption).toHaveBeenCalledWith(
      "#fuTodofukenShozai",
      "13",
    );
    expect(f.page.selectOption).not.toHaveBeenCalledWith(
      expect.any(String),
      "北海道",
    );
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

  // ⚠2026-08-15 発注者の指摘で判明した実害: 地番範囲は**開始と終わりの2欄**があり
  //   (設計 2026-07-17 probe: `#cbnDlgSearchChibanStart` 〜 `#cbnDlgSearchChibanEnd`)、
  //   実装は**開始しか埋めていなかった**。開始だけだと「そこから先が全部」返る
  //   (同 probe: 丸の内一丁目・範囲1 → 59件)。**発注者は手作業では両端に同じ地番を
  //   入れている**と確認済み＝1筆に絞るのが正しい使い方。
  it("C9s: 地番範囲は開始と終わりの**両方**へ同じ値を入れる(所在検索)", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都千代田区丸の内一丁目",
      lotNumber: "1番1",
      buildingNumber: null,
    });
    expect(f.page.fill).toHaveBeenCalledWith("#cbnDlgSearchChibanStart", "1-1");
    expect(f.page.fill).toHaveBeenCalledWith("#cbnDlgSearchChibanEnd", "1-1");
  });

  it("C9t: 有料取得(候補から取得)でも範囲の両端を入れる([同種の穴は全箇所])", async () => {
    const f = makeFakeChromium();
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    // ⚠この経路は素の fake では最後(マイページ以降)まで通らない。ここで固定したいのは
    //   **ダイアログに何を入れるか**だけなので失敗は無視する(全経路の振る舞いは下の
    //   「段階②」describe の S 系が wireStage2 で通している。⚠#379 で「この関数を叩く
    //   テストは1本も無かった」と書いたのは**誤り**=S系が既にあった)。
    await page
      .fetchByLocationCandidate!({
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        certificateType: "owner",
      })
      .catch(() => undefined);
    expect(f.page.fill).toHaveBeenCalledWith("#cbnDlgSearchChibanStart", "1-1");
    expect(f.page.fill).toHaveBeenCalledWith("#cbnDlgSearchChibanEnd", "1-1");
  });

  it("C9u: 範囲(開始)を埋める箇所には必ず範囲(終わり)も埋める(将来の3箇所目を自動検出)", () => {
    // ⚠上の2本は「いまある2経路」を押さえるだけ。3箇所目が足されたとき、
    //   片側だけ埋める実装が黙って通らないよう**回数で**縛る。
    const src = readFileSync(
      joinPath(process.cwd(), "src/lib/registry-fetch/auto-fetch.ts"),
      "utf8",
    );
    const starts =
      src.match(/fill\(\s*REGISTRY_SELECTORS\.dialogChibanRangeStart/g) ?? [];
    const ends =
      src.match(/fill\(\s*REGISTRY_SELECTORS\.dialogChibanRangeEnd/g) ?? [];
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.length).toBe(starts.length);
  });

  // ⚠2026-08-15 実課金テストが2回連続で同じ形(課金ゼロ・#myPageTable 待ちの timeout)で
  //   失敗したのを受けた発注者の指示:「検索結果の地番が物件と同一ならチェックボックスに
  //   チェックを入れて確定ボタンを押すようにしてください」。
  //   既存実装は cb.click() を**発行するだけで効いたかを確認せず**、確定(OK)の後も
  //   **ダイアログが閉じたかを確認せず** sleep で素通りしていた。選択が登録されない→
  //   確定はグレーのまま no-op→後段のマイページ待ちで死ぬ、という連鎖が観測と一致する。
  //   ここでは「登録の実測 → 確定 → 閉じたことの実測」を固定する。
  const paidDialogEvaluate =
    (scenario: { registered: boolean; okDisabled: boolean }) =>
    async (_fn: unknown, arg: unknown): Promise<unknown> => {
      if (typeof arg === "string" && arg.startsWith("{")) {
        const p = JSON.parse(arg) as { target?: string; probe?: string };
        if (p.probe === "verify-chiban-selection")
          return JSON.stringify(scenario);
        if (p.target) return "checked";
      }
      return shozaiDialogDefault(arg as string);
    };

  it("C9v: 選択がサイト側に登録されなければ、確定を押さずに課金前に中止する", async () => {
    const f = makeFakeChromium();
    f.page.evaluate.mockImplementation(
      paidDialogEvaluate({ registered: false, okDisabled: true }) as never,
    );
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await expect(
      page.fetchByLocationCandidate!({
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        certificateType: "owner",
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
    // 確定(#cbnDlgBtnOk)には一度も触れていない(domClick は evaluate にセレクタを渡す)。
    const evalArgs = f.page.evaluate.mock.calls.map((c) => c[1]);
    expect(evalArgs).not.toContain("#cbnDlgBtnOk");
  });

  it("C9w: 確定後にダイアログが閉じなければ、請求へ進まず課金前に中止する", async () => {
    const f = makeFakeChromium();
    f.page.evaluate.mockImplementation(
      paidDialogEvaluate({ registered: true, okDisabled: false }) as never,
    );
    f.page.waitForFunction.mockImplementation(async (_fn?: unknown, arg?: unknown) => {
      if (
        arg &&
        typeof arg === "object" &&
        (arg as { probe?: string }).probe === "chiban-dialog-closed"
      ) {
        throw makeTimeoutError();
      }
      return {};
    });
    const chargeState = { charged: false, aborted: false };
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await expect(
      page.fetchByLocationCandidate!({
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        certificateType: "owner",
        chargeState,
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
    const evalArgs = f.page.evaluate.mock.calls.map((c) => c[1]);
    expect(evalArgs).toContain("#cbnDlgBtnOk"); // 確定は押した
    // ⚠「閉じたかの確認」を**実際に呼んだ**こと(これが無いと、確定後に別の理由で
    //   落ちただけでもこのテストが通ってしまう=空振り)。
    expect(f.page.waitForFunction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ probe: "chiban-dialog-closed" }),
      expect.anything(),
    );
    // 請求条件の確定(課金へ向かう最初のボタン)には触れていない。
    expect(evalArgs).not.toContain('button[onclick*="fuBtnForward"]');
    // 課金境界フラグも立っていない。
    expect(chargeState.charged).toBe(false);
  });

  it("C9x: 有料取得も実況へ段を刻む。文言に住所・地番(秘匿情報)を入れない", async () => {
    const f = makeFakeChromium();
    f.page.evaluate.mockImplementation(
      paidDialogEvaluate({ registered: true, okDisabled: false }) as never,
    );
    f.page.waitForFunction.mockImplementation(async (_fn?: unknown, arg?: unknown) => {
      if (
        arg &&
        typeof arg === "object" &&
        (arg as { probe?: string }).probe === "chiban-dialog-closed"
      ) {
        throw makeTimeoutError();
      }
      return {};
    });
    const step = vi.fn((_label: string) => 1);
    const factory = resolveDefaultRegistryBrowserFactory({ chromiumLoader: f.loader });
    const page = await factory!();
    await page
      .fetchByLocationCandidate!({
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        certificateType: "owner",
        live: { step, attachShot: vi.fn() },
      })
      .catch(() => undefined);
    const labels = step.mock.calls.map((c) => String(c[0]));
    expect(labels.length).toBeGreaterThanOrEqual(3);
    // 「課金していない」ことが段の文言で分かる(お金の不安を実況で解消する)。
    expect(labels.some((l) => l.includes("課金"))).toBe(true);
    for (const l of labels) {
      expect(l).not.toContain("丸の内"); // 所在(秘匿情報)を実況の文字に載せない
      expect(l).not.toMatch(/1-1|1番1/); // 地番も同様(スクショには写るが文字は固定文言のみ)
    }
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
      arg === "#cbnDlgBtnPageNext" ? nextChecks++ === 0 : shozaiDialogDefault(arg),
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
    // ⚠数えるのは**ページ送りの待ち**だけ(所在選択ダイアログの待ちを含めない)。
    const pageTurnWaits = (
      f.page.waitForFunction as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => !isShozaiDialogWait(c[1]));
    expect(pageTurnWaits).toHaveLength(1);
  });

  it("C9q: ページ切替待ち(waitForFunction)が timeout したら以降を諦め既取得分を返す(退行なし・@codex P1)", async () => {
    const f = makeFakeChromium();
    f.page.$$eval = vi
      .fn()
      .mockResolvedValueOnce([{ candidateRef: "chk_1", lotNumber: "１－１" }]);
    // 次ページは常に有効を返すが、ページ切替待ちが timeout → 1ページ目で確定。
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "#cbnDlgBtnPageNext" ? true : shozaiDialogDefault(arg),
    );
    // ⚠timeout させるのは**ページ送りの待ち**だけ。所在選択ダイアログの待ちまで
    // 落とすと、このテストが見たいページ送りの挙動に到達しない。
    f.page.waitForFunction = vi.fn(async (_fn: unknown, arg: unknown) => {
      if (isShozaiDialogWait(arg)) return {};
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

  it("C9r: ⚠都道府県が無い住所は、ダイアログを開く前に所在エラーで止まる (@codex #358 P2)", async () => {
    // 所在選択ボタンは都道府県を選ぶまで押せない。無いまま進むとボタンが
    // 有効にならず待ち続け、最後は「外部サービスの障害(502)」に化ける。
    // 実際は**住所を直せば通る**話なので、そう伝わる分類で止める。
    const f = makeFakeChromium();
    const clicks: string[] = [];
    f.page.click = vi.fn(async (s: string) => {
      clicks.push(s);
      return undefined;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const factory = resolveDefaultRegistryBrowserFactory({
        chromiumLoader: f.loader,
      });
      const page = await factory!();
      await expect(
        page.searchByLocation!({
          address: "テスト市テスト町一丁目", // 都道府県が無い
          lotNumber: "1",
          buildingNumber: null,
        }),
      ).rejects.toMatchObject({ code: "location_rejected" });
      // ダイアログは開いていない
      expect(clicks).not.toContain("#fuShozaiSentaku");
    } finally {
      warn.mockRestore();
    }
  });

  it("C9g: 検索が0件(checkbox 無し)でロード完了なら空配列を返す(timeout にしない・@codex P2)", async () => {
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async (s: string) => {
      if (s.includes("input[type=checkbox]")) throw makeTimeoutError();
      return {};
    });
    // ロード完了(「データ取得中」が消えた)を模す → 0件として [] を返す。
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      arg === "#cbnDlgChibanCheckTbl" ? true : shozaiDialogDefault(arg),
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
      arg === "#cbnDlgChibanCheckTbl" ? false : shozaiDialogDefault(arg),
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

  it("C9: 番号取得は「該当なし」にはせず、必ず連携不備として返す（誤って not_found にしない）", async () => {
    // 元々の意図（CodexP2）: 検索ページが遅い / セレクタ変更 / 結果行レンダリング前の
    // timeout を「該当なし（found:false → not_found 404）」と誤分類しない。
    // 段階②未配線のあいだは実サイトに触れずに落とすが、**not_found にしない**という
    // この性質は維持する（「謄本が存在しない」と誤って伝えない）。
    const f = makeFakeChromium();
    f.page.waitForSelector = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    // found:false（not_found 経路）には決してならない。
    await expect(
      page.searchByRealEstateNumber("1234567890123"),
    ).rejects.not.toMatchObject({ code: "not_found" });
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
    // 送信前の goto / fill も共有デッドラインで縛る (@codex #331 R1)。
    // 縛らないと pre-submit が予算を食い、catch へ入る前に外側タイマーが発火する。
    expect(loginBody).toMatch(/page\.goto\(loginUrl, \{ timeout: stepMs\(\) \}\)/);
    const fills = loginBody.match(/page\.fill\(/g) ?? [];
    expect(fills.length).toBe(2);
    // 全ての待機 + goto + fill×2 が timeout を伴うこと
    const timeouts = loginBody.match(/timeout:/g) ?? [];
    expect(timeouts.length).toBe(waits.length + 1 + fills.length);
  });

  it.each([500, 1_000, 3_000])(
    "予算 %ims でも通常メニュー着地の確認画面プローブが予算を超えない",
    async (budget) => {
      // ⚠固定 1.5 秒のままだと、小さい予算では**正常なログイン**でも
      // このプローブ中に外側タイマーが発火し timeout 表示になる (@codex #331 R1)。
      // 通常メニュー着地ではマーカーが出ない = プローブは必ず timeout まで待つ。
      process.env.REGISTRY_FETCH_TIMEOUT_MS = String(budget);
      const f = makeFakeChromium();
      const calls: Array<{ sel: string; opts: { timeout?: number } | undefined }> =
        [];
      f.page.waitForSelector = vi.fn(async (sel: string, opts?: unknown) => {
        calls.push({ sel, opts: opts as { timeout?: number } | undefined });
        if (sel === REGISTRY_FORCE_LOGIN_MARKER) throw makeTimeoutError();
        return {};
      });
      const factory = resolveDefaultRegistryBrowserFactory({
        chromiumLoader: f.loader,
      });
      const page = await factory!();
      // 正常ログイン = throw しない
      await expect(
        page.login({ loginId: "id", password: "pw", baseUrl: "https://reg.test" }),
      ).resolves.toBeUndefined();

      const probe = calls.find((c) => c.sel === REGISTRY_FORCE_LOGIN_MARKER);
      expect(probe?.opts?.timeout).toBeDefined();
      expect(probe!.opts!.timeout!).toBeLessThan(budget);
      delete process.env.REGISTRY_FETCH_TIMEOUT_MS;
    },
  );

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

describe("段階②: 有料の請求→PDF取得フロー（fetchByLocationCandidate・fake page）", () => {
  // ⚠ここで守るのは「お金」。課金ボタン(#myPageSeikyu)が押される条件と、
  // 押した後の失敗分類(charged_but_failed)を固定する。
  //
  // fake の evaluate は引数の内容で分岐する:
  //  - "#..." 等のセレクタ文字列 = domClick(押した記録を残す)
  //  - JSON(tableSel=ダイアログ) = 対象地番の探索結果
  //  - JSON(ownerSel) = 請求事項チェックの結果
  //  - JSON(tableSel=マイページ) = 呼び出し順に [行選択, 状態確認…, 再選択] を返す
  // ⚠課金の瞬間は**確認ダイアログのＯＫ**(2026-08-19 実測)。clicked には
  // 【請求】(#btn_seikyu)しか載らないため、課金の有無は chargedNow() で見る。
  const SEIKYU = "#btn_seikyu"; // 請求ボタン=ダイアログを出すだけ(無料)
  const DIALOG_OK = "#cbnDlgBtnOk";
  const CONFIRM = 'button[onclick*="fuBtnForward"]';

  function wireStage2(
    f: ReturnType<typeof makeFakeChromium>,
    opts: {
      dialogFind?: string;
      cert?: { on: string; offResults: string[] };
      /** 選択の登録確認の応答(発注者指示 2026-08-15)。既定=登録済み。 */
      selectionVerify?: { registered: boolean; okDisabled: boolean };
      /**
       * 課金後のマイページ走査(mypage-scan)が返す行。既定=いま買った行が
       * 請求済+期限内で1件。⚠shozai は「都道府県込みの所在+地番」の形
       * (実サイト同様)。別の町の行を混ぜる等で同定の誤りを炙り出す。
       */
      mypageRows?: Array<{
        receiptNo: string;
        shozai: string;
        status: string;
        when: string;
        expiry: string;
        seikyuType?: string;
      }>;
      /** 課金後の行が永遠に準備前(請求中)のままの画面を模す(S5)。 */
      mypagePendingForever?: boolean;
      /**
       * 走査中、指定ページを**ずっと**「データ取得中」にする(SV18)。
       * 実サイトはページ送り直後に表が空のまま少し置かれることがある。
       */
      loadingPage?: number;
      /** 絞り込みが「すべて」に切り替わらない画面を模す(SM8)。 */
      filterStuck?: boolean;
      /** 1ページに表示する行数(既定=全件1ページ)。複数ページの検証に使う。 */
      rowsPerPage?: number;
      /**
       * 走査の**後**、選択の直前に表が1ページ目へ戻る画面を模す(SP2)。
       * 位置(ページ番号+ページ内位置)だけで掴むと**別の行**を選んでしまう。
       */
      resetPageBeforeSelect?: boolean;
      /** 画面の請求金額合計(#GSeikyuKingakuGokei)。既定=行の料金と同額=140。 */
      seikyuTotalText?: string;
      /** 行の料金(hidden ryokin_N)。既定=140。 */
      rowFeeText?: string;
      /** 確認ダイアログを出さない画面を模す(SC2)。 */
      noConfirmDialog?: boolean;
      /** 確認ダイアログの本文(既定=金額入り)。 */
      dialogText?: string;
      /** 確認ダイアログのボタン(既定=ＯＫ/キャンセル)。 */
      dialogButtons?: string[];
      /** 基準の二重読みが毎回ずれる(再描画が落ち着かない)画面を模す(SM9)。 */
      baselineUnstable?: boolean;
      /** 選択フェーズで選ばれた受付番号の観測用フック(SM3)。 */
      onMypageSelect?: (receiptNo: string) => void;
      /**
       * **課金前**の走査(基準採取)が返す行。既定=空(初回購入の口座)。
       * 課金前から存在する行(過去の購入)を模すときに使う=その受付番号は
       * 基準に入り、課金後の同定から除外される(@codex #390 R2 P1)。
       */
      mypageBaselineRows?: Array<{
        receiptNo: string;
        shozai: string;
        status: string;
        when: string;
        expiry: string;
        seikyuType?: string;
      }>;
      /** 確定前に読む所在(kuiki)。既定=INPUT.address(空文字で取得失敗を模す)。 */
      kuikiValue?: string;
      /** 請求リスト(確定の着地・probe13)の行。既定=対象1行(未チェック)。 */
      fudosanRows?: Array<{
        index: number;
        chiban: string;
        kuiki: string;
        seikyuType: string;
        seikyuzumi: string;
        /** 種別セル(td[3])。既定=土地。 */
        kind?: string;
      }>;
      /** 事前にチェック済みの行番号(過去操作の残りを模す)。 */
      fudosanPreChecked?: number[];
      /** 行checkboxの適用が効かない画面を模す(read-back検証の RED 用)。 */
      applyIgnored?: boolean;
    } = {},
  ) {
    const clicked: string[] = [];
    // 行データ→**実サイトと同じセル並び**(td数=10・td[6]は日時<br>受付番号)へ。
    // ⚠ここを実HTMLに合わせることで、Node側の抽出(parseMyPageRowCells)まで
    // 通しで検証される(@codex #393 R1: DOM抽出が未テストだと列取り違えを見逃す)。
    const toCells = (r: {
      receiptNo: string;
      shozai: string;
      status: string;
      when: string;
      expiry: string;
      /** 請求種別セル(td[2])。既定=所有者事項(probe16 実測形)。 */
      seikyuType?: string;
    }): string[] => [
      '<input type="checkbox">',
      "1", // No.(並び順で変わる=同定に使ってはいけない列)
      // ⚠実物どおり「不動産登記<br>（種別）」。所有者事項と全部事項は別の商品
      //   なので、fake も行ごとに変えられるようにする(@codex #394 P1)。
      `不動産登記<br>（${r.seikyuType ?? "所有者事項"}）`,
      "QRコード:要",
      // ⚠マイページの所在は先頭に種別が付く(probe16 実測)。fake も実物に合わせる。
      r.shozai.startsWith("土地・") || r.shozai.startsWith("建物・")
        ? r.shozai
        : `土地・${r.shozai}`,
      r.status,
      `${r.when}<br>${r.receiptNo}`,
      r.receiptNo ? "140" : "",
      r.receiptNo ? "40KB" : "",
      r.expiry ? r.expiry.replace("/", "/<br>") : "",
    ];
    // 課金(#btn_seikyu)を押したかで mypage-scan の見え方を切り替える(実サイト:
    // 新行は課金後に現れる。課金前の走査=基準採取には既存行だけが見える)。
    let seikyuClicked = false; // ＯＫ押下(=課金)まで到達したか
    let mypageCurrentPage = 0; // マイページのページ送り位置(rowsPerPage 指定時)
    let dialogOpen = false; // 【請求】クリックで開く確認ダイアログ
    let scanCallCount = 0;
    const mypageRows =
      opts.mypageRows ??
      [
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`, // 都道府県込み所在+全角地番(実サイト形)
          status: opts.mypagePendingForever ? "請求中" : "請求済",
          when: "2026/08/18 12:00",
          expiry: opts.mypagePendingForever ? "" : "2026/09/18",
        },
      ];
    // 請求リストの行と check 状態(fudosan-list-apply がここを書き換える)。
    const listState = {
      rows:
        opts.fudosanRows ??
        [
          {
            index: 1,
            chiban: "１－１", // サイトは全角(probe13)。INPUT.lotNumber の全角形
            kuiki: INPUT.address,
            seikyuType: "所有者事項",
            seikyuzumi: "false",
          },
        ],
      checked: new Set<number>(opts.fudosanPreChecked ?? []),
    };
    // ページ送りは page.click 経由(evaluate ではない)。fake の表示ページを進める。
    const originalClick = f.page.click;
    f.page.click = vi.fn(async (sel: string) => {
      if (sel === "#myPageTable_next") mypageCurrentPage += 1;
      if (sel === "#myPageTable_previous" && mypageCurrentPage > 0) {
        mypageCurrentPage -= 1;
      }
      return originalClick(sel);
    }) as typeof f.page.click;
    f.page.evaluate.mockImplementation(async (_fn, arg: string) => {
      if (typeof arg !== "string") return undefined;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(arg) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") {
        clicked.push(arg); // domClick / hasNext 等のセレクタ引数
        // 【請求】は**ダイアログを出すだけ**(実サイト実測・課金しない)。
        // ページ送りボタンの有効判定(pagerEnabled は evaluate に**セレクタ文字列**を渡す)。
        if (arg === "#myPageTable_next" || arg === "#myPageTable_previous") {
          const visibleAll = seikyuClicked
            ? [...(opts.mypageBaselineRows ?? []), ...mypageRows]
            : opts.mypageBaselineRows ?? [];
          const per = opts.rowsPerPage ?? visibleAll.length ?? 1;
          const lastPage = Math.max(0, Math.ceil(visibleAll.length / per) - 1);
          return arg === "#myPageTable_next"
            ? mypageCurrentPage < lastPage
            : mypageCurrentPage > 0;
        }
        if (arg === "#btn_seikyu") {
          if (!opts.noConfirmDialog) dialogOpen = true;
        }
        // ⚠所在選択ダイアログ(B案)の既定応答を返す。段階②も所在の確定を通る
        // ため、undefined のままだと所在が確定できず location_rejected になり、
        // 請求フローの検証に到達しない。
        return shozaiDialogDefault(arg);
      }
      if (typeof parsed.onSel === "string") {
        return JSON.stringify(
          opts.cert ?? {
            on: "ok",
            // off は「もう一方の買える種別1件 + 常時OFF図面類5件」= 6件。
            offResults: ["ok", "ok", "ok", "ok", "ok", "ok"],
          },
        );
      }
      if (parsed.tableSel === "#cbnDlgChibanCheckTbl") {
        return opts.dialogFind ?? "checked";
      }
      // 選択の登録確認(発注者指示 2026-08-15)。既定=登録済み・確定は押せる。
      if (parsed.probe === "verify-chiban-selection") {
        return JSON.stringify(
          opts.selectionVerify ?? { registered: true, okDisabled: false },
        );
      }
      // 課金前の金額裏取り(行の料金と請求金額合計)。
      if (parsed.probe === "seikyu-amounts") {
        return JSON.stringify({
          rowFeeText: opts.rowFeeText ?? "140",
          totalText: opts.seikyuTotalText ?? "140",
        });
      }
      // 確認ダイアログの状態(【請求】クリック後にだけ開く)。
      if (parsed.probe === "seikyu-dialog") {
        if (!dialogOpen) return JSON.stringify({ open: false });
        return JSON.stringify({
          open: true,
          buttons: opts.dialogButtons ?? ["ＯＫ", "キャンセル"],
          text: opts.dialogText ?? "請求金額は140円です。よろしいですか？",
        });
      }
      // ＯＫ押下=**ここが課金**(submit されてマイページへ遷移する)。
      if (parsed.probe === "seikyu-confirm-ok") {
        seikyuClicked = true;
        dialogOpen = false;
        return undefined;
      }
      // 絞り込みが「すべて」かの実測(@codex #390 R4)。既定=効いている。
      if (parsed.probe === "filter-verify") {
        return opts.filterStuck !== true;
      }
      // 絞り込みの適用(戻り値は使われない)。
      if (typeof parsed.filterSel === "string") {
        return undefined;
      }
      // 確定前の所在(kuiki)読み取り(probe13: 行照合の材料。押すと欄ごと消える)。
      // ⚠実サイトどおり**市区町村以下だけ**を返す(@codex #389 R1: 都道府県は
      // #fuTodofukenShozai の select に分離)。行 hidden 側は都道府県込み=
      // この非対称を fake が模すことで、連結を怠る実装はここで落ちる。
      if (parsed.probe === "kuiki-value") {
        return opts.kuikiValue ?? INPUT_REST;
      }
      // 請求リスト(確定の着地・probe13)の行一覧。既定=対象1行(未チェック)。
      if (parsed.probe === "fudosan-list-rows") {
        return JSON.stringify(
          listState.rows.map((r) => ({
            kind: "土地",
            ...r,
            // ⚠所在の隠しだけ実サイト同様に数値文字参照で返す(実測)。
            kuiki: toEntities(r.kuiki),
            checked: listState.checked.has(r.index),
          })),
        );
      }
      // 行checkboxの適用(対象だけON・他はOFF)。click 相当なのでトグルで模す。
      if (parsed.probe === "fudosan-list-apply") {
        const target = Number(parsed.targetIndex);
        if (opts.applyIgnored) return undefined; // 押しても効かない画面を模す
        for (const r of listState.rows) {
          const want = r.index === target;
          const has = listState.checked.has(r.index);
          if (has !== want) {
            if (want) listState.checked.add(r.index);
            else listState.checked.delete(r.index);
          }
        }
        return undefined;
      }
      // 適用後の read-back(ちょうど1件の実測)。
      if (parsed.probe === "fudosan-list-checked") {
        return JSON.stringify([...listState.checked].sort((a, b) => a - b));
      }
      // マイページ走査(課金前=基準採取/課金後=同定)。単一ページ想定。
      if (parsed.probe === "mypage-scan") {
        if (opts.loadingPage !== undefined && mypageCurrentPage === opts.loadingPage) {
          return JSON.stringify({ loading: true, rows: [] });
        }
        if (!seikyuClicked && opts.baselineUnstable) {
          // 呼ばれるたびに違う受付番号を返す=二重読みが一致しない。
          scanCallCount += 1;
          return JSON.stringify({
            loading: false,
            rows: [
              toCells({
                receiptNo: `2026081900FLAKY${scanCallCount}`,
                shozai: `${INPUT.address}１－１`,
                status: "請求済",
                when: "2026/08/01 09:00",
                expiry: "2026/09/01",
              }),
            ],
          });
        }
        const visible = seikyuClicked
          ? [...(opts.mypageBaselineRows ?? []), ...mypageRows]
          : opts.mypageBaselineRows ?? [];
        const per = opts.rowsPerPage ?? visible.length ?? 1;
        const start = mypageCurrentPage * per;
        return JSON.stringify({
          loading: false,
          rows: visible.slice(start, start + per).map(toCells),
        });
      }
      // 課金後の選択フェーズ(受付番号で選ぶ)。対象が居れば ready。
      // 走査の後に表が戻る画面(SP2)。peek/select の直前で1ページ目へ。
      if (parsed.probe === "mypage-peek" || parsed.probe === "mypage-select") {
        if (opts.resetPageBeforeSelect) mypageCurrentPage = 0;
      }
      // 選ぶ前の下見: 位置の行のセルを返すだけ(解釈は実装側の純関数)。
      if (parsed.probe === "mypage-peek") {
        const visible = seikyuClicked
          ? [...(opts.mypageBaselineRows ?? []), ...mypageRows]
          : opts.mypageBaselineRows ?? [];
        const per = opts.rowsPerPage ?? visible.length ?? 1;
        const row = visible[mypageCurrentPage * per + Number(parsed.rowIndex)];
        return JSON.stringify(
          row ? { found: true, cells: toCells(row) } : { found: false, cells: [] },
        );
      }
      if (parsed.probe === "mypage-select") {
        // 走査順(基準行→課金で生まれた行)の位置で掴む=実装と同じ契約。
        const visible = seikyuClicked
          ? [...(opts.mypageBaselineRows ?? []), ...mypageRows]
          : opts.mypageBaselineRows ?? [];
        const per = opts.rowsPerPage ?? visible.length ?? 1;
        // ⚠**ページ内の位置**で掴む(実装と同じ契約)。全体の通し番号ではない。
        const row = visible[mypageCurrentPage * per + Number(parsed.rowIndex)];
        if (!row) return JSON.stringify({ result: "not-found" });
        opts.onMypageSelect?.(row.receiptNo);
        // ⚠read-back は**選ばれた行のセル**を返す(受付番号の一致は実装側が判定)。
        return JSON.stringify({ result: "checked", cells: toCells(row) });
      }
      return undefined;
    });
    return { clicked, chargedNow: () => seikyuClicked };
  }

  const INPUT = {
    // ⚠**都道府県から始まる住所にする**。所在選択ダイアログは都道府県を選ぶまで
    // 開けないため、都道府県が無い住所は所在の指定エラーで先に止まる
    // (実データも都道府県から入っている前提)。
    address: "東京都テスト市テスト町一丁目",
    lotNumber: "1-1",
    buildingNumber: null,
    certificateType: "owner" as const,
  };
  // #fuChibanKuiki 相当(市区町村以下)。実サイトは都道府県を select に分離して
  // 持つ(@codex #389 R1)ので、欄の値には都道府県が入らない。
  const INPUT_REST = "テスト市テスト町一丁目";
  /**
   * 請求リストの行の隠し所在(#chibanKuiki_N)。⚠実サイトはここ**だけ**を
   * 数値文字参照で持つ(2026-08-19 第6回テストで no-match の原因として実測)。
   * fake もその形で返し、解かない実装が通らないようにする。
   */
  const toEntities = (t: string): string =>
    [...t].map((ch) => `&#${ch.codePointAt(0)};`).join("");

  async function makeStage2Page(f: ReturnType<typeof makeFakeChromium>) {
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    return (await factory!()) as unknown as {
      fetchByLocationCandidate: (input: typeof INPUT) => Promise<Buffer>;
    };
  }


  it("S1: 幸せ経路 — 確定→行選択→請求→請求済→表示・保存で PDF を返す(請求は1回だけ)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f);
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked).toContain(DIALOG_OK);
    expect(clicked).toContain(CONFIRM);
    // probe13+発注者指示: 確定の着地=請求リストで行をcheckし、【請求】を**直接**押す。
    // マイページへ登録するボタンや旧 selectTab('tabMy') タブは押さない。
    expect(clicked).not.toContain("a[onclick*=\"selectTab('tabMy')\"]");
    expect(clicked.join(" ")).not.toContain("btnForward2");
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1); // 請求ボタンは1回
  });

  it("SL1: ⚠請求リストに対象の行が無ければ、登録も請求も押さずに中止(別の筆を買わない)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      fudosanRows: [
        // 地番が違う行だけがある(過去操作の残り等)。
        { index: 1, chiban: "９９－９", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false" },
      ],
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).toContain(CONFIRM); // 確定までは進む(無料)
    expect(clicked).not.toContain(SEIKYU); // 課金ボタンには触れない
  });

  it("SL2: ⚠同一内容の未請求が複数残っていても、先頭の1件だけで進める(2件checkしない)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      fudosanRows: [
        { index: 2, chiban: "１－１", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false" },
        { index: 1, chiban: "１－１", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false" },
      ],
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1);
  });

  it("SL3: ⚠checkの適用が画面に効かなければ、read-backで見抜いて登録前に中止", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { applyIgnored: true });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(SEIKYU); // 課金ボタンには触れない
  });

  it("SL4: ⚠所在(kuiki)が読めていなければ行を選ばない(照合の土台なし=中止)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { kuikiValue: "" });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(SEIKYU); // 課金ボタンには触れない
  });

  it("SL5: ⚠過去操作でcheck済みの別行が残っていても、対象1件だけに直してから登録する", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      fudosanRows: [
        { index: 1, chiban: "１－１", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false" },
        // 地番違い(選ばれてはいけない)がなぜか check 済みで残っている。
        { index: 2, chiban: "９９－９", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false" },
      ],
      fudosanPreChecked: [2],
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1);
  });

  it("SL6: ⚠請求済みの行しか無ければ選ばない(再請求の入口を作らない)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      fudosanRows: [
        { index: 1, chiban: "１－１", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "true" },
      ],
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(SEIKYU); // 課金ボタンには触れない
  });

  it("S2: ⚠対象の地番が見つからなければ not_found で終了し、確定も請求も押さない", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { dialogFind: "not-found" });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(clicked).not.toContain(DIALOG_OK);
    expect(clicked).not.toContain(CONFIRM);
    expect(clicked).not.toContain(SEIKYU);
    expect(clicked).toContain("#cbnDlgBtnCancel"); // ダイアログは閉じる
  });

  it("S3: ⚠請求事項を選んだ種別だけに揃えられなければ、請求を押さずに中止（余計なものを買わない）", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      // off にできない請求事項が1つでもある(=余計なものを買う)なら中止。
      cert: { on: "ok", offResults: ["failed", "ok", "ok", "ok", "ok", "ok"] },
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(CONFIRM);
    expect(clicked).not.toContain(SEIKYU);
  });

  it("S5: ⚠請求後に行が準備完了に到達しなければ charged_but_failed（provider_error にしない）", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { mypagePendingForever: true });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "charged_but_failed",
    });
    expect(clicked).toContain(SEIKYU); // 課金は押している=だから分類が変わる
  });

  it("SM1: ⚠別の町の同一地番の請求済行を掴んでDLしない(提出前レビュー confidence82)", async () => {
    // 口座のマイページ全履歴に「別の町の 1-1」(請求済・期限内・日時も新しい)しか
    // 見えない状況。旧実装(地番末尾×最新)はこれを掴んで他人の筆のPDFを添付した。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageRows: [
        {
          receiptNo: "2026081900000009",
          shozai: "東京都別の市別の町１－１", // 地番は同じ・所在(町)が違う
          status: "請求済",
          when: "2026/08/18 23:59",
          expiry: "2026/09/18",
        },
      ],
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "charged_but_failed", // 課金はした(押した)が、取り違えず「見つからない」で終える
    });
    expect(clicked).toContain(SEIKYU);
    // ⚠取り違えのDL(表示・保存)を押していないことが本題。
    expect(clicked.join(" ")).not.toContain("myPageDownload");
  });

  it("SM2: ⚠同じ筆の古い請求済行(課金前から存在)へ乗り換えない=新行が準備前の間は待つ", async () => {
    // 乗り換えると「古い購入のPDF」を今回の結果として添付してしまう。
    // 古い行は**基準**(課金前の走査)で控えられ、同定から除外される(@codex R2 P1)。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [
        {
          receiptNo: "2026080100000001",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/01 09:00", // 古い(課金前から存在)
          expiry: "2026/09/01",
        },
      ],
      mypageRows: [
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求中", // いま買った行はまだ準備前のまま
          when: "2026/08/18 12:00",
          expiry: "",
        },
      ],
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "charged_but_failed",
    });
    expect(clicked).toContain(SEIKYU);
    expect(clicked.join(" ")).not.toContain("myPageDownload");
  });

  it("SM7: ⚠基準の走査に受付番号が空の行が混ざったら、課金前に中止する(@codex #390 R3 P1)", async () => {
    // 空IDの行を黙って飛ばして基準を成立させると、その行が課金後にIDを得て
    // 「新規」に化け、古いPDFを掴む(旧 #345 R4 P1 の all-or-nothing の復元)。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [
        {
          receiptNo: "", // 一時的にIDが描画されていない行
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/01 09:00",
          expiry: "2026/09/01",
        },
      ],
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(CONFIRM); // 確定前に止まる=カート行も作らない
    expect(clicked).not.toContain(SEIKYU);
  });

  it("SM5: ⚠新行が最後まで表に現れなくても、基準内の古いready行をDLしない(@codex #390 R2 P1)", async () => {
    // 旧実装は「見えている最新」が古い行しか無い局面でそれを ready として掴んだ。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [
        {
          receiptNo: "2026080100000001",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/01 09:00",
          expiry: "2026/09/01",
        },
      ],
      mypageRows: [], // 新行が(異常に)最後まで現れない
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "charged_but_failed",
    });
    expect(clicked).toContain(SEIKYU);
    expect(clicked.join(" ")).not.toContain("myPageDownload");
  });

  it("SM6: 基準内の古い行と、遅れて現れた新行(ready)が並んだら、新行を受付番号で選ぶ", async () => {
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [
        {
          receiptNo: "2026080100000001",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/30 09:00", // わざと日時は新行より新しくしておく
          expiry: "2026/09/30",
        },
      ],
      mypageRows: [
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/18 12:00",
          expiry: "2026/09/18",
        },
      ],
      onMypageSelect: (trId) => selects.push(trId),
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // 基準除外により、日時の新旧に関わらず「基準に無い行」だけが同定対象。
    expect(selects).toEqual(["2026081900727233"]);
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1);
  });

  it("SM3: 同じ筆の古い行と新しい行(準備完了)が並んだら、新しい行を受付番号で選ぶ", async () => {
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { clicked } = wireStage2(f, {
      mypageRows: [
        {
          receiptNo: "2026080100000001",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/01 09:00",
          expiry: "2026/09/01",
        },
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/18 12:00",
          expiry: "2026/09/18",
        },
      ],
      onMypageSelect: (trId) => selects.push(trId),
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1);
    expect(selects).toEqual(["2026081900727233"]); // 最新=いま買った行だけを選ぶ
  });

  it("SM4: ⚠町名延長の別区域(…町東)の新しい行があっても、対象区域の行を受付番号で選ぶ(@codex #390 R1 P1)", async () => {
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { clicked } = wireStage2(f, {
      mypageRows: [
        {
          receiptNo: "2026081900000077", // 別区域(テスト町一丁目東)・より新しい・ready
          shozai: `${INPUT.address}東１－１`,
          status: "請求済",
          when: "2026/08/18 23:59",
          expiry: "2026/09/18",
        },
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/18 12:00",
          expiry: "2026/09/18",
        },
      ],
      onMypageSelect: (trId) => selects.push(trId),
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1);
    expect(selects).toEqual(["2026081900727233"]);
  });

  it("SM8: ⚠絞り込みを「すべて」へ切り替えられない間は基準を成立させない(@codex #390 R4 P1)", async () => {
    // select に前回の「未請求」等が残ったままだと基準が部分集合になり、
    // 隠れていた古い購入が課金後に「新規」へ化ける。検証できなければ課金前に中止。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { filterStuck: true });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(CONFIRM); // 確定前に止まる=カート行も作らない
    expect(clicked).not.toContain(SEIKYU);
  });

  it("SL7: ⚠同番号の土地と建物が並んでも、請求対象の種別の行だけをcheckする(@codex #390 R5 P1)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      fudosanRows: [
        { index: 1, chiban: "１－１", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false", kind: "建物" },
        { index: 2, chiban: "１－１", kuiki: INPUT.address, seikyuType: "所有者事項", seikyuzumi: "false", kind: "土地" },
      ],
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT); // INPUT=地番のみ=土地
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked.filter((s) => s === SEIKYU)).toHaveLength(1);
  });

  it("SM9: ⚠基準の二重読みが安定しない間は課金前に中止する(@codex #390 R6 P1)", async () => {
    // select の値は同期・表の再描画は非同期。読みのたびに集合がずれる=描画が
    // 落ち着いていない基準を採用すると、隠れていた行が「新規」に化ける。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { baselineUnstable: true });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(CONFIRM);
    expect(clicked).not.toContain(SEIKYU);
  });

  it("SC1: ⚠請求金額合計が行の料金と違えば、確認ダイアログも出さずに中止(課金ゼロ)", async () => {
    const f = makeFakeChromium();
    const { clicked, chargedNow } = wireStage2(f, { seikyuTotalText: "280" });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(SEIKYU); // 請求ボタンにも触れない
    expect(chargedNow()).toBe(false);
  });

  it("SC2: ⚠確認ダイアログが出なければ課金しない(第7回はここで止まっていた)", async () => {
    const f = makeFakeChromium();
    const { clicked, chargedNow } = wireStage2(f, { noConfirmDialog: true });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error", // 課金していないので charged_but_failed にしない
    });
    expect(clicked).toContain(SEIKYU); // 請求ボタンは押した(無料)
    expect(chargedNow()).toBe(false);
  }, 25_000); // ダイアログ待ちの実時間(15秒)を含むため長め

  it("SC3: ⚠確認ダイアログの金額が想定と違えばＯＫを押さない", async () => {
    const f = makeFakeChromium();
    const { chargedNow } = wireStage2(f, {
      dialogText: "請求金額は280円です。よろしいですか？",
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(chargedNow()).toBe(false);
  });

  it("SC4: ⚠押してよいボタンが判別できなければ押さない(取り消し側を誤爆しない)", async () => {
    const f = makeFakeChromium();
    const { chargedNow } = wireStage2(f, { dialogButtons: ["続行", "戻る"] });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(chargedNow()).toBe(false);
  });

  it("SC5: 「はい/いいえ」形式の確認でも「はい」を押して完走する", async () => {
    const f = makeFakeChromium();
    const { chargedNow } = wireStage2(f, {
      dialogButtons: ["はい", "いいえ"],
      dialogText: "140円を請求します。よろしいですか？",
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(chargedNow()).toBe(true);
  });

  it("SR1: ⚠受付番号で同定する(No.列は使わない)=第8回の「買った行を古い行と誤認」の再発防止", async () => {
    // 実サイトの td[1] は画面上の連番(No.)で、請求直後は**新しい行が No=1** になる。
    // 基準を No で作ると「いま買った行」が基準に含まれ、永久に見つからない(課金済み・
    // PDF未取得で終わる)。受付番号(td[6]の2段目)は行に固有で並び順に影響されない。
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { chargedNow } = wireStage2(f, {
      // 課金前から在る未請求行(受付番号なし=実サイトどおり)。
      mypageBaselineRows: [
        {
          receiptNo: "",
          shozai: `${INPUT.address}１－１`,
          status: "未請求",
          when: "",
          expiry: "",
        },
      ],
      // 課金で生まれた行(受付番号つき・請求済)。
      mypageRows: [
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/19 15:20",
          expiry: "2026/08/24",
        },
      ],
      onMypageSelect: (receiptNo) => selects.push(receiptNo),
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(chargedNow()).toBe(true);
    expect(selects).toEqual(["2026081900727233"]);
  });

  it("SM10: ⚠課金後の同定も謄本の種類まで一致させる(所有者事項を買って全部事項を掴まない)", async () => {
    // 同じ筆の別種別の行が同時に現れると、種類を見ない実装は**新しい方**を掴む。
    // 添付されるPDFと『買った種類』がずれると、所有者反映の有無まで食い違う。
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { chargedNow } = wireStage2(f, {
      mypageRows: [
        {
          receiptNo: "2026081900000ALL",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/19 15:30",
          expiry: "2026/09/18",
          seikyuType: "全部事項",
        },
        {
          receiptNo: "2026081900000OWN",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/19 15:20",
          expiry: "2026/09/18",
        },
      ],
      onMypageSelect: (receiptNo) => selects.push(receiptNo),
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT); // certificateType=owner
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(chargedNow()).toBe(true);
    expect(selects).toEqual(["2026081900000OWN"]);
  });
  it("SR2: ⚠未請求行(受付番号なし)が基準にあっても中止しない(all-or-nothingの誤爆防止)", async () => {
    // 旧規則(空IDがあれば基準無効)を受付番号へ機械的に移すと、未請求行が1件あるだけで
    // 永久に課金前中止になる。無効にするのは「未請求でないのに受付番号が空」のときだけ。
    const f = makeFakeChromium();
    const { chargedNow } = wireStage2(f, {
      mypageBaselineRows: [
        { receiptNo: "", shozai: "x", status: "未請求", when: "", expiry: "" },
        { receiptNo: "", shozai: "y", status: "未請求", when: "", expiry: "" },
      ],
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(chargedNow()).toBe(true);
  });

  it("SR3: ⚠「未請求でないのに受付番号が空」の行があれば基準を無効にして課金前に中止", async () => {
    const f = makeFakeChromium();
    const { clicked, chargedNow } = wireStage2(f, {
      mypageBaselineRows: [
        { receiptNo: "", shozai: "x", status: "請求済", when: "2026/08/01 09:00", expiry: "2026/09/01" },
      ],
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(clicked).not.toContain(CONFIRM);
    expect(chargedNow()).toBe(false);
  });

  it("SP1: ⚠買った行が2ページ目にあっても選べる(@codex #393 R2 P1: 通し番号をページ内位置に使わない)", async () => {
    // 1ページ2行・基準2行(過去の購入)+課金で生まれた1行=3行 → 対象は2ページ目の先頭。
    // 通し番号(=2)をそのままページ内位置として渡すと必ず外し、課金済みなのに
    // PDFを取り逃す(charged_but_failed)。
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { chargedNow } = wireStage2(f, {
      rowsPerPage: 2,
      mypageBaselineRows: [
        {
          receiptNo: "2026080100000001",
          shozai: `${INPUT.address}９－９`,
          status: "請求済",
          when: "2026/08/01 09:00",
          expiry: "2026/09/01",
        },
        {
          receiptNo: "",
          shozai: `${INPUT.address}１－１`,
          status: "未請求",
          when: "",
          expiry: "",
        },
      ],
      mypageRows: [
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/19 15:20",
          expiry: "2026/08/24",
        },
      ],
      onMypageSelect: (receiptNo) => selects.push(receiptNo),
    });
    const page = await makeStage2Page(f);
    const buf = await page.fetchByLocationCandidate(INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(chargedNow()).toBe(true);
    expect(selects).toEqual(["2026081900727233"]); // 2ページ目の先頭を正しく選ぶ
  }, 30_000);

  it("SP2: ⚠選択の直前に表が1ページ目へ戻っても、別の行を選ばない(@codex #393 R3 P1)", async () => {
    // 走査時は2ページ目に対象が見えていたが、選択の直前に表が戻る(ページ送りが
    // 一瞬無効になる等)。位置だけで掴むと1ページ目の**別の筆**を選び、支払って
    // いないPDFを添付し得る。⇒ 選ぶ前と後の両方で受付番号を実測して弾く。
    const f = makeFakeChromium();
    const selects: string[] = [];
    const { chargedNow } = wireStage2(f, {
      rowsPerPage: 1,
      resetPageBeforeSelect: true,
      mypageBaselineRows: [
        {
          receiptNo: "2026080100000001",
          shozai: `${INPUT.address}９－９`,
          status: "請求済",
          when: "2026/08/01 09:00",
          expiry: "2026/09/01",
        },
      ],
      mypageRows: [
        {
          receiptNo: "2026081900727233",
          shozai: `${INPUT.address}１－１`,
          status: "請求済",
          when: "2026/08/19 15:20",
          expiry: "2026/08/24",
        },
      ],
      onMypageSelect: (receiptNo) => selects.push(receiptNo),
    });
    const page = await makeStage2Page(f);
    await expect(page.fetchByLocationCandidate(INPUT)).rejects.toMatchObject({
      code: "charged_but_failed",
    });
    expect(chargedNow()).toBe(true);
    // ⚠**別の筆の行を選んでいない**(ここが本題)。
    expect(selects).toEqual([]);
  }, 90_000);

  it("S9: ⚠中止の印(aborted)が立っていたら請求ボタンを押さない（@codex R10 P1）", async () => {
    // provider が課金前タイムアウトで reject した後も、この関数は裏で走り続ける。
    // 印を見ずに押すと、呼び出し側は timeout(台帳なし・ロック解除済み)として処理を
    // 終えているのに課金だけが起きる=記録なき課金。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f);
    const page = await makeStage2Page(f);
    await expect(
      (page as unknown as {
        fetchByLocationCandidate: (input: unknown) => Promise<Buffer>;
      }).fetchByLocationCandidate({
        ...INPUT,
        chargeState: { charged: false, aborted: true },
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(clicked).not.toContain(SEIKYU); // 請求は押していない
  });

  it("S6: 買う対象(地番/家屋番号)が空なら何もせず provider_error（ページに触れない）", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f);
    const page = await makeStage2Page(f);
    await expect(
      page.fetchByLocationCandidate({ ...INPUT, lotNumber: "  " }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(clicked).toHaveLength(0);
    expect(f.page.fill).not.toHaveBeenCalled();

  });

  const DOWNLOAD = 'button[onclick*="myPageDownload"]'; // 「表示・保存」=無料
  // ---- 【回収】既に購入済みの書類を、課金せずに取り込む(2026-08-19) ----
  // 背景: 第8回テストで請求は成立(140円)したのにPDFを取り逃した。期限内なら
  // 課金せず回収できる。⚠この経路が課金ボタンに触れないことを**実際に動かして**確かめる。
  async function makeRecoverPage(f: ReturnType<typeof makeFakeChromium>) {
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    return (await factory!()) as unknown as {
      recoverRegistryPdfByLocation: (input: {
        address: string;
        lotNumber?: string | null;
        buildingNumber?: string | null;
        certificateType: "owner" | "all";
      }) => Promise<Buffer>;
    };
  }
  const RECOVER_INPUT = {
    address: INPUT.address,
    lotNumber: INPUT.lotNumber,
    buildingNumber: null,
    certificateType: "owner" as const,
  };
  /** マイページに**既にある**行(課金前から見えている=回収の対象)。 */
  const boughtRow = (over: Record<string, string> = {}) => ({
    receiptNo: "2026081900727233",
    shozai: `${INPUT.address}１－１`,
    status: "請求済",
    when: "2026/08/19 15:21",
    expiry: "2026/08/24",
    ...over,
  });

  it("SV1: 回収 — 請求済・期限内の行を見つけて PDF を返す(請求ボタンに触れない)", async () => {
    const f = makeFakeChromium();
    const { clicked, chargedNow } = wireStage2(f, {
      mypageBaselineRows: [boughtRow()],
    });
    const page = await makeRecoverPage(f);
    const buf = await page.recoverRegistryPdfByLocation(RECOVER_INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // ⚠お金の操作を一切していない。
    expect(clicked).not.toContain(SEIKYU);
    expect(clicked).not.toContain(CONFIRM);
    expect(clicked).not.toContain(DIALOG_OK);
    expect(chargedNow()).toBe(false);
    // 使ったのは表示・保存だけ。
    expect(clicked).toContain(DOWNLOAD);
  });

  it("SV2: ⚠まだ買っていない(未請求)行しか無ければ取り込まない=課金もしない", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ status: "未請求", expiry: "" })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(SEIKYU);
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV3: ⚠期限切れ(取得期限が空)の行は取り込まない", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ expiry: "" })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV4: ⚠地番が違う行は取り込まない(別の筆のPDFを物件に貼らない)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ shozai: `${INPUT.address}１－１０` })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV5: ⚠所在(町)が違う行は取り込まない", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ shozai: "東京都別市別町二丁目１－１" })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV6: ⚠土地を探しているのに建物の行しか無ければ取り込まない(種別の取り違え)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ shozai: `建物・${INPUT.address}１－１` })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV7: 対象が2ページ目にあってもページを送って取り込む", async () => {
    const f = makeFakeChromium();
    const seen: string[] = [];
    wireStage2(f, {
      rowsPerPage: 1,
      mypageBaselineRows: [
        boughtRow({
          receiptNo: "2026081900000001",
          shozai: `${INPUT.address}９９－９`,
        }),
        boughtRow(),
      ],
      onMypageSelect: (r) => seen.push(r),
    });
    const page = await makeRecoverPage(f);
    const buf = await page.recoverRegistryPdfByLocation(RECOVER_INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // 掴んだのは対象の受付番号(位置ではなく中身で選んでいる)。
    expect(seen).toEqual(["2026081900727233"]);
  });

  it("SV8: ⚠選ぶ直前に表が1ページ目へ戻ったら、別の行をDLせず中止する", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      rowsPerPage: 1,
      resetPageBeforeSelect: true,
      mypageBaselineRows: [
        boughtRow({
          receiptNo: "2026081900000001",
          shozai: `${INPUT.address}９９－９`,
        }),
        boughtRow(),
      ],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV10: ⚠物件の所在が地番まで入っていても取り込める(本番データの実形)", async () => {
    // 実データ実測(2026-08-19): properties.address =「神奈川県横浜市南区井土ケ谷中町69-2」
    // のように**末尾に地番が入っている**。所在をそのまま照合キーにすると、
    // マイページの所在「土地・…中町６９－２」から前半を除いた残りが空になり、
    // 正しい行まで弾かれる=回収したいそのものが取り込めない。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow()],
    });
    const page = await makeRecoverPage(f);
    const buf = await page.recoverRegistryPdfByLocation({
      ...RECOVER_INPUT,
      // 所在の末尾に地番(全角)まで入っている状態。
      address: `${INPUT.address}１－１`,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(clicked).toContain(DOWNLOAD);
  });

  it("SV11: ⚠末尾が対象の地番でなければ所在は削らない(別の町を通さない)", async () => {
    // 「…中町東」のように町名が延びた別区域は、地番を外す処理があっても
    // 通ってはいけない(区域の取り違え=別人の筆)。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ shozai: `${INPUT.address}東１－１` })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation({
        ...RECOVER_INPUT,
        address: `${INPUT.address}１－１`,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV12: ⚠所在の末尾が数字続きのときは取り込まない(169-2 を 69-2 として掴まない)", async () => {
    // 物件の所在が「…一丁目169-2」で対象地番が「69-2」という食い違いがあると、
    // 数字の途中で切る実装は区域を「…一丁目1」にしてしまい、マイページの
    // 「…一丁目１６９－２」の行に一致する=**別の筆のPDFを貼る**。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ shozai: `${INPUT.address}１６９－２` })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation({
        ...RECOVER_INPUT,
        address: `${INPUT.address}169-2`,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });

  it("SV13: ⚠同じ筆で両方買っていても、要求した種類の行だけを取り込む", async () => {
    // 所有者事項と全部事項は別の商品。取り違えると、所有者事項のPDFを全部事項
    // として添付したり、全部事項で所有者を反映してしまう(@codex #394 P1)。
    const f = makeFakeChromium();
    const seen: string[] = [];
    wireStage2(f, {
      mypageBaselineRows: [
        // 全部事項の方が**新しい**=種類を見ないとこちらを掴む。
        boughtRow({
          receiptNo: "2026081900000ALL",
          when: "2026/08/19 15:30",
          seikyuType: "全部事項",
        }),
        boughtRow({ receiptNo: "2026081900000OWN", when: "2026/08/19 15:20" }),
      ],
      onMypageSelect: (r) => seen.push(r),
    });
    const page = await makeRecoverPage(f);
    const buf = await page.recoverRegistryPdfByLocation(RECOVER_INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(seen).toEqual(["2026081900000OWN"]);
  });

  it("SV14: ⚠要求した種類が1件も無ければ取り込まない", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      mypageBaselineRows: [boughtRow({ seikyuType: "全部事項" })],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(clicked).not.toContain(DOWNLOAD);
  });
  it("SV15: 奥のページ(11ページ目)にある購入も取り込む", async () => {
    // 回収の対象は**過去に買ったもの**。上限が小さいと、まだ期限内の購入が
    // 奥にあっても『見つかりません』と嘘をつく(@codex #394 R4 P2)。
    const f = makeFakeChromium();
    const seen: string[] = [];
    const filler = Array.from({ length: 10 }, (_, i) =>
      boughtRow({
        receiptNo: `20260819000000${String(i).padStart(2, "0")}`,
        shozai: `${INPUT.address}９９－${i + 1}`,
      }),
    );
    wireStage2(f, {
      rowsPerPage: 1,
      mypageBaselineRows: [...filler, boughtRow()],
      onMypageSelect: (r) => seen.push(r),
    });
    const page = await makeRecoverPage(f);
    const buf = await page.recoverRegistryPdfByLocation(RECOVER_INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(seen).toEqual(["2026081900727233"]);
  });

  it("SV16: ⚠履歴を最後まで見られなかったときは『無い』と言わない", async () => {
    // 上限で打ち切ったのに not_found にすると、まだ期限内の購入を『無い』ことに
    // してしまい、利用者は諦めて期限を過ぎる(=買った分が消える)。
    const f = makeFakeChromium();
    const many = Array.from({ length: 70 }, (_, i) =>
      boughtRow({
        receiptNo: `20260819000001${String(i).padStart(2, "0")}`,
        shozai: `${INPUT.address}９９－${i + 1}`,
      }),
    );
    const { clicked } = wireStage2(f, {
      rowsPerPage: 1,
      mypageBaselineRows: many,
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(clicked).not.toContain(DOWNLOAD);
    expect(clicked).not.toContain(SEIKYU); // 課金は一切しない
  });

  it("SV17: 履歴が15ページあっても、先頭まで戻って正しい行を取り込む", async () => {
    // 走査は深くまで行けるのに戻りが浅いと、位置の意味がずれて受付番号の
    // 読み戻しで必ず外れる=取り込めるはずのPDFを取り逃す(@codex #394 R5 P2)。
    const f = makeFakeChromium();
    const seen: string[] = [];
    const filler = Array.from({ length: 14 }, (_, i) =>
      boughtRow({
        receiptNo: `20260819000010${String(i).padStart(2, "0")}`,
        shozai: `${INPUT.address}９９－${i + 1}`,
      }),
    );
    wireStage2(f, {
      rowsPerPage: 1,
      mypageBaselineRows: [...filler, boughtRow()],
      onMypageSelect: (r) => seen.push(r),
    });
    const page = await makeRecoverPage(f);
    const buf = await page.recoverRegistryPdfByLocation(RECOVER_INPUT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(seen).toEqual(["2026081900727233"]);
  });

  it("SV18: ⚠読み込み中のページがあったら『無い』と言わない", async () => {
    // 表が「データ取得中」のまま抜けて not_found にすると、買った書類が
    // その先にあっても利用者は諦め、期限切れで失う。
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, {
      rowsPerPage: 1,
      loadingPage: 1, // 2ページ目がいつまでも読み込み中
      mypageBaselineRows: [
        boughtRow({
          receiptNo: "2026081900001000",
          shozai: `${INPUT.address}９９－１`,
        }),
        boughtRow(),
      ],
    });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation(RECOVER_INPUT),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(clicked).not.toContain(DOWNLOAD);
    expect(clicked).not.toContain(SEIKYU);
  });

  it("SV9: 買う対象(地番/家屋番号)が空なら何もしない(ページに触れない)", async () => {
    const f = makeFakeChromium();
    const { clicked } = wireStage2(f, { mypageBaselineRows: [boughtRow()] });
    const page = await makeRecoverPage(f);
    await expect(
      page.recoverRegistryPdfByLocation({ ...RECOVER_INPUT, lotNumber: "  " }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(clicked).toHaveLength(0);
  });
});

describe("段階②: マイページ行の地番一致（部分一致で別の登記を買わない）", () => {
  // ⚠「1-1」が「1-10」「11-1」の所在にも当たると**別の登記に課金**する(@codex #345 P1)。
  // ブラウザ内(evaluate)の判定はこの関数と同一規則を複製している(対で維持)。
  it.each([
    ["千代田区丸の内一丁目１－１", "1-1", true], // 全角の実表記
    ["千代田区丸の内一丁目1-1", "1-1", true],
    ["千代田区丸の内一丁目1-10", "1-1", false], // 末尾不一致
    ["千代田区丸の内一丁目11-1", "1-1", false], // 境界が数字
    ["千代田区丸の内一丁目21-1", "1-1", false],
    ["テスト町1番1", "1-1", true], // 慣用表記も正規化して一致
    ["", "1-1", false],
    ["千代田区丸の内一丁目1-1", "", false], // 空の対象は常に不一致(全行一致を防ぐ)
  ])("%s × %s → %s", (cell, target, want) => {
    expect(registryRowMatchesChiban(cell, target)).toBe(want);
  });
});

describe("段階②: 課金対象は「確定で作られた行」に紐付ける（@codex #345 R2 P1・ソース固定）", () => {
  // 行の同定ロジックは evaluate 内(ブラウザで実行)にあり fake page では実行されないため、
  // ここでは**配線の存在**をソースで固定する(実挙動の最終確認は実課金テスト)。
  const src = readFileSync(
    joinPath(process.cwd(), "src", "lib", "registry-fetch", "auto-fetch.ts"),
    "utf8",
  );

  it("⚠基準は二重読みの集合一致で採用する(@codex #390 R6: 非同期再描画の旧表示を掴まない)", () => {
    expect(src).toContain("const collectBaselineOnce");
    expect(src).toContain("if (changed) await sleep(2000);");
    // 二重読み(first/second)と集合一致の検査。
    expect(src).toContain("const first = await collectBaselineOnce();");
    expect(src).toContain("const second = await collectBaselineOnce();");
    expect(src).toContain("first.ids.size !== second.ids.size");
  });

  it("⚠基準の走査は「すべて」適用+実測検証の後(@codex #390 R4: 残留フィルタで部分集合にしない)", () => {
    const verifyAt = src.indexOf("const verifyAllFilter");
    expect(verifyAt).toBeGreaterThan(-1);
    // 基準ブロック内で apply→verify→reset の順。
    const blockAt = src.indexOf("baselineTrIds.clear()");
    const applyAt = src.indexOf(String.raw`applyMyPageFilter("すべて")`, blockAt);
    const verifyCallAt = src.indexOf("verifyAllFilter()", blockAt);
    const resetAt = src.indexOf("resetMyPageToFirst()", blockAt);
    expect(applyAt).toBeGreaterThan(blockAt);
    expect(verifyCallAt).toBeGreaterThan(applyAt);
    expect(resetAt).toBeGreaterThan(verifyCallAt);
  });

  it("⚠基準は全行の受付番号が読めた時だけ成立する(空IDは取り直し・@codex #390 R3)", () => {
    const baselineAt = src.indexOf("const baselineTrIds");
    const confirmAt = src.indexOf("domClick(REGISTRY_SELECTORS.requestConfirmButton)");
    expect(baselineAt).toBeGreaterThan(-1);
    expect(baselineAt).toBeLessThan(confirmAt); // 基準採取は確定より前
    // 受付番号ベース(2026-08-19 第8回)。未請求行は受付番号を持たないのが正常なので、
    // 成立規則は純関数(collectBaselineReceiptNos)に集約した。
        // 受付番号ベース(2026-08-19 第8回)。解釈は純関数へ集約し、DOM側は生セルのみ。
    expect(src).toContain("collectBaselineReceiptNos(parsedRows)");
    expect(src).toContain("parseMyPageRowCells(cells)");
    expect(src).not.toContain("tds[1]?.textContent"); // No.列は使わない
  });

  it("⚠マイページの基準控え(row-ids)を復活させない(発注者指示 2026-08-18=直接請求)", () => {
    // 旧: 確定前にマイページの行IDを控え、確定後の「新規行」をマイページで選んで
    // 課金していた。発注者指示「マイページに登録はせずに直接請求します」で、
    // 課金対象の選択は請求リスト側の行照合(fudosan-list-select)に一本化された。
    expect(src).not.toContain('probe: "row-ids"');
    expect(src).not.toContain("prevIds.includes(rowId)");
    // 課金前の未請求絞込・単一ページ要求も旧経路専用(行が溜まると誤中止を生む)。
    expect(src).not.toContain('applyMyPageFilter("未請求")');
    expect(src).not.toContain("await myPageIsSinglePage()");
  });

  it("⚠課金の瞬間は**確認ダイアログのＯＫ**(2026-08-19 実測)。charged=true はその直前", () => {
    expect(src).toContain("domClick(REGISTRY_SELECTORS.fudosanListSeikyuButton)");
    expect(src).not.toContain("myPageSeikyuButton");
    // 【請求】クリック(無料)→ダイアログ待ち→ＯＫ(課金)の順。
    const seikyuClickAt = src.indexOf(
      "await domClick(REGISTRY_SELECTORS.fudosanListSeikyuButton)",
    );
    const dialogAt = src.indexOf('probe: "seikyu-dialog"');
    const okAt = src.indexOf('probe: "seikyu-confirm-ok"');
    expect(seikyuClickAt).toBeGreaterThan(-1);
    expect(dialogAt).toBeGreaterThan(seikyuClickAt);
    expect(okAt).toBeGreaterThan(dialogAt);
    // charged=true は**ＯＫの直前**(請求クリック時点ではまだ課金していない)。
    const chargedAt = src.lastIndexOf("chargeState.charged = true", okAt);
    expect(chargedAt).toBeGreaterThan(seikyuClickAt);
    expect(chargedAt).toBeLessThan(okAt);
    // 着地(マイページ一覧)待ちはＯＫの後。
    expect(src.indexOf("REGISTRY_SELECTORS.myPageTable", okAt)).toBeGreaterThan(okAt);
  });

  it("⚠課金前に「行の料金=請求金額合計」を実測する(選択が増えていたら課金しない)", () => {
    expect(src).toContain('probe: "seikyu-amounts"');
    expect(src).toContain("resolveSeikyuConfirm(");
    const gateAt = src.indexOf("resolveSeikyuConfirm(");
    const seikyuClickAt = src.indexOf(
      "await domClick(REGISTRY_SELECTORS.fudosanListSeikyuButton)",
    );
    expect(gateAt).toBeLessThan(seikyuClickAt); // 押す前に裏取り
    expect(src).toContain("REGISTRY_SELECTORS.seikyuTotalAmount");
  });

  it("課金後の同定は純関数 pickChargedMyPageRow(所在前半+地番境界+最新)で行う", () => {
    // 提出前レビュー(confidence82)対応: 地番末尾だけの同定は**別の町の同一地番**を
    // 掴む。走査(mypage-scan)→Node側で同定→受付番号で選択(mypage-select)の二相。
    // ⚠走査フィルタは「すべて」(@codex #390 R1 P1: 請求済に絞ると請求中の
    // 新行が隠れ、同じ筆の古い請求済行を「見えている最新」として掴む)。
    expect(src).toContain(String.raw`applyMyPageFilter("すべて")`);
    expect(src).not.toContain(String.raw`applyMyPageFilter("請求済")`);
    expect(src).toContain("pickChargedMyPageRow(");
    expect(src).toContain('probe: "mypage-scan"');
    expect(src).toContain('probe: "mypage-select"');
    // 旧: 地番末尾×最新×最初のページ、の evaluate 内同定は撤去。
    expect(src).not.toContain(String.raw`rowId: "",`);
    expect(src).not.toContain("rowId ? trId !== rowId :");
  });

  it("⚠課金後の各走査は先頭ページから始める(@codex R6 P1: 末尾に居座って見逃さない)", () => {
    expect(src).toContain("await resetMyPageToFirst();");
    // 走査ループ(pageNo)より前に呼ぶ
    expect(src.indexOf("await resetMyPageToFirst();")).toBeLessThan(
      src.indexOf("for (let pageNo = 0; pageNo < 10; pageNo++)"),
    );
  });

  it("⚠課金後のダウンロード待ちは明示予算を渡す(@codex R9 P1: 既定30秒に先取りされない)", () => {
    // page.setDefaultTimeout は通常予算のまま。timeout を渡さないと provider の
    // 延長予算(10分)より先にブラウザ側の既定が打ち切り、支払済みが台帳固定される。
    expect(src).toContain(
      'page.waitForEvent("download", { timeout: PAID_DOWNLOAD_WAIT_MS })',
    );
  });

});

/**
 * 所在選択ダイアログの**段送りを実際に動かす** fake。
 *
 * ⚠ソース走査型の配線テストでは、`canFix !== "NO"` を `===` に書き間違えても
 * 通ってしまう(文字列は同じだけ並ぶ)。2026-08-10 の本番実障害は
 * **動かさないと分からない状態機械のバグ**だったので、ここは実際に回す。
 *
 * 実サイトの2つの作りをそのまま持たせる (2026-08-10 `GKuikiDialog.js` 実測):
 *  - ダイアログの「確定」は `#canFix` が "YES" のときだけ押せる
 *    (`GKuikiDialogSetButtonStatus`)
 *  - 最終段の区域は押した時点で所在欄が埋まり**ダイアログが閉じる**
 *    (`GKuikiDialogFixed`)
 */
function makeShozaiLevels(opts: {
  levels: {
    items: { id: string; text: string; code: string }[];
    canFix: "YES" | "NO";
  }[];
  closesOnFinalPick?: boolean;
  /**
   * 閉じ方が「**隠すだけ**」で、区域の td が DOM に残る作り(@codex #368 R1 P1)。
   * jQuery UI の dialog("close") は中身を消さずに隠すことがあり、その場合
   * 最終段を押した後も同じ丁目の一覧が読めてしまう。
   */
  keepItemsAfterClose?: boolean;
}) {
  let level = 0;
  let closed = false;
  let filled = false;
  const picks: string[] = [];
  const lastLevel = () => opts.levels[opts.levels.length - 1];
  const canFixNow = (): string => {
    if (closed) return opts.keepItemsAfterClose ? lastLevel().canFix : "";
    return level >= opts.levels.length ? "YES" : opts.levels[level].canFix;
  };
  const evaluate = (arg: string): unknown => {
    if (arg === '#kuikiDialogArea td[id^="GKuiki"]') {
      if (closed) {
        if (!opts.keepItemsAfterClose) return [];
        return lastLevel().items.map((it) => ({ ...it, visible: true }));
      }
      if (level >= opts.levels.length) return [];
      return opts.levels[level].items.map((it) => ({ ...it, visible: true }));
    }
    if (arg === "#kuikiDialogArea #canFix") return canFixNow();
    if (arg === "#fuChibanKuiki") return filled; // 所在欄が埋まっているか
    if (arg === ".GKuikiDialogSelectedText") return "path:" + String(level);
    if (arg === ".ui-dialog-buttonpane button") return canFixNow() === "YES";
    return shozaiDialogDefault(arg);
  };
  const click = (sel: string): void => {
    if (!sel.startsWith("#GKuiki")) return;
    picks.push(sel);
    level += 1;
    if (opts.closesOnFinalPick && level >= opts.levels.length) {
      closed = true;
      filled = true;
    }
  };
  return { evaluate, click, picks };
}

describe("所在選択ダイアログの段送り（2026-08-10 本番実障害・実際に動かす）", () => {
  const setup = (dialog: ReturnType<typeof makeShozaiLevels>) => {
    const f = makeFakeChromium();
    const clicks: string[] = [];
    f.page.click = vi.fn(async (s: string) => {
      clicks.push(s);
      dialog.click(s);
      return undefined;
    });
    f.page.evaluate = vi.fn(async (_fn: unknown, arg: string) =>
      dialog.evaluate(arg),
    );
    f.page.$$eval = vi.fn(async () => [
      { candidateRef: "cbnDlgChibanChk_1", lotNumber: "１８－３" },
    ]);
    return { f, clicks };
  };

  it("⚠町名の次に「丁目」だけが並ぶ段を降り切る（世田谷区若林2-18-3）", async () => {
    // 実障害: 残り「2-18-3」を地番と早合点して降りるのをやめ、丁目を選び残した
    // まま確定できずに止まっていた(ログ: fix button not enabled)。
    const dialog = makeShozaiLevels({
      levels: [
        {
          items: [{ id: "GKuiki0", text: "世田谷区", code: "13112" }],
          canFix: "NO",
        },
        { items: [{ id: "GKuiki1", text: "若林", code: "0012" }], canFix: "NO" },
        {
          items: [
            { id: "GKuiki2", text: "一丁目", code: "01" },
            { id: "GKuiki3", text: "二丁目", code: "02" },
            { id: "GKuiki4", text: "三丁目", code: "03" },
          ],
          canFix: "NO",
        },
      ],
      closesOnFinalPick: true,
    });
    const { f, clicks } = setup(dialog);
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都世田谷区若林2-18-3",
      lotNumber: "18-3",
      buildingNumber: null,
    });
    // 区 → 町名 → **二丁目**（丁目を選び残さない・別の丁目を選ばない）
    expect(dialog.picks).toEqual(["#GKuiki0", "#GKuiki1", "#GKuiki3"]);
    // ⚠カートに未請求行を作るページ本体の確定には触れない
    expect(clicks).not.toContain("#fuBtnForward");
    expect(clicks).not.toContain("#myPageSeikyu");
  });

  it("⚠最終段でダイアログが閉じる作りでも成功にする（確定ボタンはもう押せない）", async () => {
    const dialog = makeShozaiLevels({
      levels: [
        {
          items: [{ id: "GKuiki0", text: "千代田区", code: "13101" }],
          canFix: "NO",
        },
        {
          items: [{ id: "GKuiki1", text: "丸の内一丁目", code: "0001" }],
          canFix: "NO",
        },
      ],
      closesOnFinalPick: true,
    });
    const { f, clicks } = setup(dialog);
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都千代田区丸の内1-1-1",
      lotNumber: "1-1",
      buildingNumber: null,
    });
    expect(dialog.picks).toEqual(["#GKuiki0", "#GKuiki1"]);
    expect(clicks).not.toContain("#fuBtnForward");
  });

  it("⚠閉じ方が「隠すだけ」で区域が DOM に残っても、次の段を読みに行かない（@codex #368 R1 P1）", async () => {
    // jQuery UI の dialog("close") は中身を消さずに隠すことがある。その作りだと
    // 最終段を押した後も同じ丁目の一覧が読めてしまい、残った地番「18-3」を
    // 丁目として突き合わせて中止する(＝直したはずの不具合が再発する)。
    // 押した直後に所在欄を見て抜けることで、閉じ方に依存しなくなる。
    const dialog = makeShozaiLevels({
      levels: [
        {
          items: [{ id: "GKuiki0", text: "世田谷区", code: "13112" }],
          canFix: "NO",
        },
        { items: [{ id: "GKuiki1", text: "若林", code: "0012" }], canFix: "NO" },
        {
          items: [
            { id: "GKuiki2", text: "一丁目", code: "01" },
            { id: "GKuiki3", text: "二丁目", code: "02" },
          ],
          canFix: "NO",
        },
      ],
      closesOnFinalPick: true,
      keepItemsAfterClose: true,
    });
    const { f, clicks } = setup(dialog);
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都世田谷区若林2-18-3",
      lotNumber: "18-3",
      buildingNumber: null,
    });
    // 二丁目を押した時点で終わり（同じ段をもう一度読まない）
    expect(dialog.picks).toEqual(["#GKuiki0", "#GKuiki1", "#GKuiki3"]);
    expect(clicks).not.toContain("#fuBtnForward");
  });

  it("⚠一覧に無い丁目は選ばずに中止する（取り違えて別の土地を買わない）", async () => {
    const dialog = makeShozaiLevels({
      levels: [
        {
          items: [{ id: "GKuiki0", text: "世田谷区", code: "13112" }],
          canFix: "NO",
        },
        { items: [{ id: "GKuiki1", text: "若林", code: "0012" }], canFix: "NO" },
        {
          items: [
            { id: "GKuiki2", text: "一丁目", code: "01" },
            { id: "GKuiki3", text: "二丁目", code: "02" },
          ],
          canFix: "NO",
        },
      ],
      closesOnFinalPick: true,
    });
    const { f } = setup(dialog);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const factory = resolveDefaultRegistryBrowserFactory({
        chromiumLoader: f.loader,
      });
      const page = await factory!();
      await expect(
        page.searchByLocation!({
          address: "東京都世田谷区若林9-18-3", // 9丁目は一覧に無い
          lotNumber: "18-3",
          buildingNumber: null,
        }),
      ).rejects.toMatchObject({ code: "location_rejected" });
      // 丁目は1つも押していない
      expect(dialog.picks).toEqual(["#GKuiki0", "#GKuiki1"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("確定できる段まで来たら、残りが地番でもそこで確定する（従来の正常系）", async () => {
    const dialog = makeShozaiLevels({
      levels: [
        {
          items: [{ id: "GKuiki0", text: "千代田区", code: "13101" }],
          canFix: "NO",
        },
        {
          items: [{ id: "GKuiki1", text: "丸の内一丁目", code: "0001" }],
          canFix: "NO",
        },
        { items: [{ id: "GKuiki2", text: "甲", code: "A" }], canFix: "YES" },
      ],
    });
    const { f, clicks } = setup(dialog);
    const factory = resolveDefaultRegistryBrowserFactory({
      chromiumLoader: f.loader,
    });
    const page = await factory!();
    await page.searchByLocation!({
      address: "東京都千代田区丸の内1-1-1",
      lotNumber: "1-1",
      buildingNumber: null,
    });
    // 「甲」は住所に無いので押さない。確定できる段なのでそこで確定する。
    expect(dialog.picks).toEqual(["#GKuiki0", "#GKuiki1"]);
    expect(clicks).not.toContain("#fuBtnForward");
  });
});
