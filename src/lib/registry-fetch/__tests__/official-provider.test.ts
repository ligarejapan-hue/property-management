import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  OfficialRegistryProvider,
  type RegistryBrowserPage,
  type RegistryBrowserFactory,
} from "../official-provider";
import { createRegistryFetchThrottle } from "../throttle";
import { RegistryFetchError } from "../errors";
import { __resetPurchaseChainForTest } from "../purchase-safety";
import type { RegistryFetchProvider, RegistryFetchErrorCode } from "../types";

const VALID_PDF = Buffer.from("%PDF-1.4 mock registry bytes");

/**
 * テスト用の最小ブラウザページ。実 Playwright を起動せず、各メソッドの戻り/throw を
 * 注入で制御し、呼び出し順序を calls に記録する（注入境界の検証用）。
 */
function makeFakePage(
  over: Partial<{
    login: (input: { loginId: string; password: string; baseUrl?: string }) => Promise<void>;
    searchByRealEstateNumber: (n: string) => Promise<{ found: boolean }>;
    downloadRegistryPdf: () => Promise<Buffer>;
    /** 段階②: 有料の地番取得。指定時のみ adapter が対応している状態を模す。 */
    fetchByLocationCandidate: (input: {
      address: string;
      lotNumber?: string | null;
      buildingNumber?: string | null;
      certificateType: "owner";
    }) => Promise<Buffer>;
  }> = {},
): RegistryBrowserPage & { calls: string[]; closed: boolean } {
  const state = { calls: [] as string[], closed: false };
  return {
    calls: state.calls,
    get closed() {
      return state.closed;
    },
    // over に fetchByLocationCandidate がある時だけメソッドを生やす(optional seam の模擬)。
    ...(over.fetchByLocationCandidate
      ? {
          async fetchByLocationCandidate(input: {
            address: string;
            lotNumber?: string | null;
            buildingNumber?: string | null;
            certificateType: "owner";
          }) {
            state.calls.push("fetchByLocation");
            return over.fetchByLocationCandidate!(input);
          },
        }
      : {}),
    async login(input) {
      state.calls.push("login");
      if (over.login) await over.login(input);
    },
    async searchByRealEstateNumber(n: string) {
      state.calls.push("search");
      if (over.searchByRealEstateNumber)
        return over.searchByRealEstateNumber(n);
      return { found: true };
    },
    async downloadRegistryPdf() {
      state.calls.push("download");
      if (over.downloadRegistryPdf) return over.downloadRegistryPdf();
      return VALID_PDF;
    },
    async close() {
      state.calls.push("close");
      state.closed = true;
    },
  };
}

function makeProvider(opts: {
  page?: RegistryBrowserPage & { calls: string[]; closed: boolean };
  factory?: RegistryBrowserFactory;
  baseUrl?: string;
  timeoutMs?: number;
  throttle?: ReturnType<typeof createRegistryFetchThrottle>;
  paidFlowExtraTimeoutMs?: number;
  now?: () => Date;
}) {
  const page = opts.page ?? makeFakePage();
  let factoryCalls = 0;
  const factory: RegistryBrowserFactory =
    opts.factory ??
    (async () => {
      factoryCalls++;
      return page;
    });
  const provider = new OfficialRegistryProvider({
    loginId: "SECRET_ID",
    password: "SECRET_PW",
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    browserFactory: factory,
    throttle: opts.throttle,
    paidFlowExtraTimeoutMs: opts.paidFlowExtraTimeoutMs,
    now: opts.now ?? (() => new Date(0)),
    requestIdFactory: () => "req-fixed",
  });
  return { provider, page, factoryCalls: () => factoryCalls };
}

describe("OfficialRegistryProvider（PR-2 実フロー・fake page 注入・外部接続なし）", () => {
  it("A1: RegistryFetchProvider に準拠し name='official'", () => {
    const provider: RegistryFetchProvider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
    });
    expect(provider.name).toBe("official");
    expect(typeof provider.fetchRegistryPdf).toBe("function");
  });

  it("A2: browserFactory 未注入なら provider_error で安全停止（外部接続不能・fail-closed）", async () => {
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
    });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "0123", ref: "prop-1" }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("A2b: browserFactory が生エラーで reject したら provider_error に正規化（生メッセージ非露出）", async () => {
    // 動的 Playwright import / chromium.launch / newContext / newPage 失敗を模す。
    // 例: 依存未導入ホストで raw Error（パス/内部情報混入しうる）が出るケース。
    const factory: RegistryBrowserFactory = async () => {
      throw new Error(
        "Cannot find module 'playwright' at C:/secret/path SECRET_TOKEN",
      );
    };
    const provider = new OfficialRegistryProvider({
      loginId: "SECRET_ID",
      password: "SECRET_PW",
      browserFactory: factory,
    });
    try {
      await provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryFetchError);
      expect((err as RegistryFetchError).code).toBe("provider_error");
      const serialized = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
      expect(serialized).not.toContain("playwright");
      expect(serialized).not.toContain("secret/path");
      expect(serialized).not.toContain("SECRET_TOKEN");
    }
  });

  it("A2c: browserFactory が RegistryFetchError(rate_limited) で reject したら同 code を伝播", async () => {
    // 既存の例外正規化方針と統一: RegistryFetchError は分類コードを保ったまま伝播する。
    const factory: RegistryBrowserFactory = async () => {
      throw new RegistryFetchError("rate_limited");
    };
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
      browserFactory: factory,
    });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("A3: 成功フロー — login→search→download→close の順で実行し RegistryFetchResult を返す", async () => {
    const { provider, page } = makeProvider({ baseUrl: "https://reg.test" });
    const res = await provider.fetchRegistryPdf({
      realEstateNumber: "1234567890123",
      ref: "prop-1",
    });
    expect(res.pdfBuffer).toBe(VALID_PDF);
    expect(res.fileName).toBe("registry-auto-req-fixed.pdf"); // 非PII の generic filename
    expect(res.source).toBe("official");
    expect(res.providerRequestId).toBe("req-fixed");
    expect(res.fetchedAt.getTime()).toBe(0);
    expect(page.calls).toEqual(["login", "search", "download", "close"]);
    expect(page.closed).toBe(true);
  });

  it("A3b: login に baseUrl と資格情報が渡る（page 側に保持させない契約）", async () => {
    const loginSpy = vi.fn(async () => {});
    const page = makeFakePage({ login: loginSpy });
    const { provider } = makeProvider({ page, baseUrl: "https://reg.test" });
    await provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" });
    expect(loginSpy).toHaveBeenCalledWith({
      loginId: "SECRET_ID",
      password: "SECRET_PW",
      baseUrl: "https://reg.test",
    });
  });

  it("A3c: search に渡すのは非PII の不動産番号のみ（所有者名/住所/ref を渡さない）", async () => {
    const searchSpy = vi.fn(async () => ({ found: true }));
    const page = makeFakePage({ searchByRealEstateNumber: searchSpy });
    const { provider } = makeProvider({ page });
    await provider.fetchRegistryPdf({
      realEstateNumber: "1234567890123",
      ref: "prop-uuid",
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith("1234567890123");
  });

  it("A4: realEstateNumber が無ければ not_found（所在系 PII 検索は PR-2b・factory 未呼び出し）", async () => {
    const { provider, factoryCalls } = makeProvider({});
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: null, ref: "p" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "   ", ref: "p" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(factoryCalls()).toBe(0);
  });

  it("A5: 検索ヒットなし（found=false）→ not_found・download せず close する", async () => {
    const page = makeFakePage({
      searchByRealEstateNumber: async () => ({ found: false }),
    });
    const { provider } = makeProvider({ page });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(page.closed).toBe(true);
    expect(page.calls).not.toContain("download");
  });

  const CLASSIFY: RegistryFetchErrorCode[] = [
    "auth_failed",
    "timeout",
    "rate_limited",
    "provider_error",
  ];
  for (const code of CLASSIFY) {
    it(`A6: page が RegistryFetchError(${code}) を投げたら同 code を伝播し close する`, async () => {
      const page = makeFakePage({
        login: async () => {
          throw new RegistryFetchError(code);
        },
      });
      const { provider } = makeProvider({ page });
      await expect(
        provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
      ).rejects.toMatchObject({ code });
      expect(page.closed).toBe(true);
    });
  }

  it("A7: page が RegistryFetchError 以外を投げたら provider_error に正規化（生メッセージ非含有）", async () => {
    const page = makeFakePage({
      searchByRealEstateNumber: async () => {
        throw new Error("RAW selector .login-xyz at https://reg.test/secret");
      },
    });
    const { provider } = makeProvider({ page });
    try {
      await provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryFetchError);
      expect((err as RegistryFetchError).code).toBe("provider_error");
      const serialized = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
      expect(serialized).not.toContain("selector");
      expect(serialized).not.toContain("reg.test");
    }
    expect(page.closed).toBe(true);
  });

  it("A8: timeoutMs を超えるフローは timeout で打ち切られ close される", async () => {
    const page = makeFakePage({
      // login が解決しない（ハング）→ timeout race で打ち切る
      login: () => new Promise<void>(() => {}),
    });
    const { provider } = makeProvider({ page, timeoutMs: 10 });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(page.closed).toBe(true);
  });

  it("A8b: timeoutMs を超えるブラウザ起動（factory ハング）も timeout で打ち切られる", async () => {
    // CodexP2: factory（動的 import / chromium.launch / newContext / newPage）が解決しない
    // = 起動ハング。timeout は login/search/download だけでなく **起動全体** に効く必要がある
    // （効かないと runRegistryAutoFetch が scheduled のまま catch へ到達せず物件が固着する）。
    const factory: RegistryBrowserFactory = () =>
      new Promise<RegistryBrowserPage>(() => {
        /* 永遠に解決しない（起動ハング） */
      });
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
      timeoutMs: 10,
      browserFactory: factory,
    });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("A8c: factory が timeout 後に遅れて page を返したら、その page を close する（リーク防止）", async () => {
    // 起動が timeout を超えた後に factory が解決した場合、宙に浮いた page を確実に閉じる。
    const lateClose = vi.fn(async () => {});
    let resolveFactory: ((p: RegistryBrowserPage) => void) | undefined;
    const factory: RegistryBrowserFactory = () =>
      new Promise<RegistryBrowserPage>((resolve) => {
        resolveFactory = resolve;
      });
    const provider = new OfficialRegistryProvider({
      loginId: "id",
      password: "pw",
      timeoutMs: 10,
      browserFactory: factory,
    });
    const promise = provider.fetchRegistryPdf({
      realEstateNumber: "1",
      ref: "p",
    });
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    // timeout 後に factory が遅れて page を返す。
    const latePage = makeFakePage();
    latePage.close = lateClose;
    resolveFactory?.(latePage);
    // microtask を一巡させて late-close が走るのを待つ。
    await Promise.resolve();
    await Promise.resolve();
    expect(lateClose).toHaveBeenCalledTimes(1);
  });

  it("A9: download が失敗しても close される（リーク防止）", async () => {
    const page = makeFakePage({
      downloadRegistryPdf: async () => {
        throw new RegistryFetchError("provider_error");
      },
    });
    const { provider } = makeProvider({ page });
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(page.closed).toBe(true);
  });

  it("T1: throttle が拒否したら rate_limited で停止し factory を呼ばない（公式を叩く前に止まる）", async () => {
    const throttle = createRegistryFetchThrottle({ minIntervalMs: 60_000 });
    let t = 1_000_000;
    const { provider, factoryCalls } = makeProvider({
      throttle,
      now: () => new Date(t),
    });
    await provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }); // 1 回目 OK
    t += 1; // 間隔未満
    await expect(
      provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "p" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(factoryCalls()).toBe(1); // 2 回目は factory 未呼び出し
  });

  it("P2: 戻り値 RegistryFetchResult に secret/PII を含まない", async () => {
    const { provider } = makeProvider({ baseUrl: "https://secret-base.test" });
    const res = await provider.fetchRegistryPdf({
      realEstateNumber: "1234567890123",
      ref: "owner-pii-ref",
    });
    const json = JSON.stringify({ ...res, pdfBuffer: undefined });
    expect(json).not.toContain("SECRET_ID");
    expect(json).not.toContain("SECRET_PW");
    expect(json).not.toContain("secret-base.test");
    expect(json).not.toContain("1234567890123");
  });

  it("A11/C-1. official-provider.ts は Playwright を静的 import / require しない（バンドル混入防止）", () => {
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

  it("A10: 失敗例外（RegistryFetchError）に secret/PII/baseUrl を載せない", async () => {
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

describe("OfficialRegistryProvider: supportsLocationSearch(所在検索の専用ゲート)", () => {
  it("option 既定は false・true 指定で true(所在検索の露出を独立に制御)", () => {
    expect(
      new OfficialRegistryProvider({ loginId: "id", password: "pw" }).supportsLocationSearch,
    ).toBe(false);
    expect(
      new OfficialRegistryProvider({
        loginId: "id",
        password: "pw",
        supportsLocationSearch: true,
      }).supportsLocationSearch,
    ).toBe(true);
  });
});

describe("段階②: 所在候補の有料取得（fetchByLocation・fake page 注入・外部接続なし）", () => {
  const LOCATION = {
    address: "テスト市テスト町一丁目",
    lotNumber: "1-1",
    buildingNumber: null,
    certificateType: "owner" as const,
  };

  beforeEach(() => {
    __resetPurchaseChainForTest();
  });

  it("L1: adapter が未対応(メソッド無し)なら login の前に provider_error（実ログインを無駄にしない・課金前）", async () => {
    const page = makeFakePage(); // fetchByLocationCandidate 無し
    const { provider } = makeProvider({ page });
    await expect(
      provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(page.calls).not.toContain("login");
    expect(page.closed).toBe(true); // 失敗経路でも必ず close
  });

  it("L2: login → fetchByLocationCandidate の順で実行し PDF を返す", async () => {
    let received: unknown;
    const page = makeFakePage({
      fetchByLocationCandidate: async (input) => {
        received = input;
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({ page });
    const result = await provider.fetchRegistryPdf({
      location: LOCATION,
      ref: "p1",
    });
    // 課金境界フラグ(chargeState)が provider から注入される(@codex #345 P1/R10)。
    // paidDeadlineAt(外側タイマーの締切)も provider が注入する(@codex #386 R2)。
    // timeoutMs 未指定=外側タイマー無し(withPaidTimeout と同じ判定)→ 締切も null。
    // ⚠fake の中で expect すると reject が classify に飲まれ原因が見えない → 外で検証。
    expect(received).toEqual({
      ...LOCATION,
      chargeState: { charged: false, aborted: false },
      paidDeadlineAt: null,
    });
    expect(result.pdfBuffer).toBe(VALID_PDF);
    expect(result.source).toBe("official");
    // 非PII filename（地番・所有者名を含まない）
    expect(result.fileName).toBe("registry-auto-req-fixed.pdf");
    expect(page.calls).toEqual(["login", "fetchByLocation", "close"]);
  });

  it("L2b: ⚠paidDeadlineAt の基準は外側タイマー開始時刻=ログインの所要時間で締切が伸びない(@codex #386 R2)", async () => {
    // adapter 入口(=ログイン後)で残量を測り直すと、ログインが食った時間ぶん
    // 残りを過大評価し、0件リトライが外側 timeout を再び踏む。
    const LOGIN_DELAY_MS = 500;
    let received: number | null | undefined;
    const page = makeFakePage({
      login: async () => {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
      },
      fetchByLocationCandidate: async (input) => {
        received = (input as { paidDeadlineAt?: number | null }).paidDeadlineAt;
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({ page, timeoutMs: 30000 });
    const before = Date.now();
    await provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" });
    expect(typeof received).toBe("number");
    // 開始時刻基準: before + 30000 + 僅少な起動オーバーヘッドに収まる。
    // ログイン後に測っていたら before + LOGIN_DELAY_MS + 30000 以上になり失敗する。
    expect((received as number) - before).toBeGreaterThanOrEqual(30000);
    expect((received as number) - before).toBeLessThan(30000 + LOGIN_DELAY_MS);
  });

  it("L3: ⚠課金後の失敗(charged_but_failed)は分類を変えずに上げる（provider_error に潰さない）", async () => {
    // 潰すと呼び出し側が「リトライ可能な upstream 障害」と誤認し、再実行=二重課金につながる。
    const page = makeFakePage({
      fetchByLocationCandidate: async () => {
        throw new RegistryFetchError("charged_but_failed");
      },
    });
    const { provider } = makeProvider({ page });
    await expect(
      provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" }),
    ).rejects.toMatchObject({ code: "charged_but_failed" });
    expect(page.closed).toBe(true);
  });

  it("L4: 不動産番号があれば番号取得を優先し、有料の地番フローには入らない", async () => {
    const page = makeFakePage({
      fetchByLocationCandidate: async () => {
        throw new Error("should not be called");
      },
    });
    const { provider } = makeProvider({ page });
    const result = await provider.fetchRegistryPdf({
      realEstateNumber: "0123456789012",
      location: LOCATION,
      ref: "p1",
    });
    expect(Buffer.isBuffer(result.pdfBuffer)).toBe(true);
    expect(page.calls).toContain("search");
    expect(page.calls).not.toContain("fetchByLocation");
  });

  it("L6: ⚠課金後に予算が尽きたら charged_but_failed に分類する（素の timeout にしない）", async () => {
    // 素の timeout で返すと呼び出し側は台帳に書かず再実行できてしまう=二重課金(@codex #345 P1)。
    const page = makeFakePage({
      fetchByLocationCandidate: async (input) => {
        // adapter が請求ボタンを押した直後を模す: フラグを立ててから固まる。
        (input as { chargeState?: { charged: boolean } }).chargeState!.charged = true;
        await new Promise(() => {}); // 予算が尽きるまで解決しない
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({
      page,
      timeoutMs: 30,
      paidFlowExtraTimeoutMs: 50, // テストでは延長予算も短く注入
    });
    await expect(
      provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" }),
    ).rejects.toMatchObject({ code: "charged_but_failed" });
    expect(page.closed).toBe(true);
  });

  it("L8: ⚠課金後は通常予算を超えても延長予算内なら完走する（@codex #345 R8 P1）", async () => {
    // 通常予算(例30秒)は課金後の「請求済+PDF準備」待ち(最大60秒+)より短くなり得る。
    // 支払済みなのに打ち切って charged_but_failed に固定しない=延長予算で取り切る。
    const page = makeFakePage({
      fetchByLocationCandidate: async (input) => {
        (input as { chargeState?: { charged: boolean } }).chargeState!.charged = true;
        await new Promise((r) => setTimeout(r, 80)); // 通常予算(30ms)は超えるが延長内
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({
      page,
      timeoutMs: 30,
      paidFlowExtraTimeoutMs: 500,
    });
    const result = await provider.fetchRegistryPdf({
      location: LOCATION,
      ref: "p1",
    });
    expect(result.pdfBuffer).toBe(VALID_PDF);
  });

  it("L9: 課金前は通常予算どおり打ち切る（timeout のまま・無料なので早く諦めてよい）", async () => {
    const page = makeFakePage({
      fetchByLocationCandidate: async () => {
        // charged を立てずに固まる=課金前のハング。
        await new Promise(() => {});
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({
      page,
      timeoutMs: 30,
      paidFlowExtraTimeoutMs: 500,
    });
    await expect(
      provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("L7: ⚠検索のログインも購入と同じミューテックスを通る（購入中の検索が先発セッションを切らない）", async () => {
    const order: string[] = [];
    let releasePurchase!: () => void;
    const gate = new Promise<void>((r) => { releasePurchase = r; });
    const page = makeFakePage({
      fetchByLocationCandidate: async () => {
        order.push("purchase-start");
        await gate;
        order.push("purchase-end");
        return VALID_PDF;
      },
    });
    (page as unknown as { searchByLocation: unknown }).searchByLocation = async () => {
      order.push("search-run");
      return [];
    };
    const { provider } = makeProvider({ page });
    const purchase = provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" });
    const search = provider.searchCandidates!({ address: "テスト市1" });
    await new Promise((r) => setTimeout(r, 20));
    // 検索は購入が終わるまで走らない(=先発の購入セッションを強制ログアウトさせない)。
    expect(order).toEqual(["purchase-start"]);
    releasePurchase();
    await Promise.all([purchase, search]);
    expect(order).toEqual(["purchase-start", "purchase-end", "search-run"]);
  });

  it("L5: ⚠購入は1件ずつ直列化される（1IDにつき同時1セッション=並行すると先発の課金だけ残る）", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const page = makeFakePage({
      fetchByLocationCandidate: async () => {
        const n = ++call;
        order.push(`start-${n}`);
        if (n === 1) await firstGate; // 1件目を保留し、2件目が追い越さないことを見る
        order.push(`end-${n}`);
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({ page });
    const p1 = provider.fetchRegistryPdf({ location: LOCATION, ref: "p1" });
    const p2 = provider.fetchRegistryPdf({
      location: { ...LOCATION, lotNumber: "2-2" },
      ref: "p2",
    });
    // 2件目が追い越していないことを確認してから 1件目を解放する。
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start-1"]);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});

describe("段階②: 課金前タイムアウトの競合（@codex #345 R10 P1）", () => {
  beforeEach(() => {
    __resetPurchaseChainForTest();
  });

  const LOCATION2 = {
    address: "テスト市テスト町一丁目",
    lotNumber: "1-1",
    buildingNumber: null,
    certificateType: "owner" as const,
  };

  it("L10: 課金前タイムアウトで reject する際、中止の印(aborted)を立てる", async () => {
    // reject しても op はキャンセルされない。裏で走り続けた adapter が後から
    // 請求しないよう、印を見て自主的に止まれる状態にする。
    let seen: { charged: boolean; aborted?: boolean } | null = null;
    const page = makeFakePage({
      fetchByLocationCandidate: async (input) => {
        seen = (
          input as unknown as {
            chargeState: { charged: boolean; aborted?: boolean };
          }
        ).chargeState;
        await new Promise((r) => setTimeout(r, 120)); // 課金前のまま soft timeout を跨ぐ
        return VALID_PDF;
      },
    });
    const { provider } = makeProvider({
      page,
      timeoutMs: 30,
      paidFlowExtraTimeoutMs: 500,
    });
    await expect(
      provider.fetchRegistryPdf({ location: LOCATION2, ref: "p1" }),
    ).rejects.toMatchObject({ code: "timeout" });
    // reject 時点で中止の印が立っている(裏で走る adapter が請求直前に見て止まる)。
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(true);
    expect(seen!.charged).toBe(false);
  });
});
