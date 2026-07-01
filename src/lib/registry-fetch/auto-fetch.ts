/**
 * 謄本自動取得連携 — 自動取得オーケストレーション（PR4・mock provider のみ）。
 *
 * PR1〜PR3 の部品を接続し、本番外部接続なしで「自動取得APIの骨格」を提供する:
 *   provider(mock) で謄本PDFを取得 → extractTextFromPdf → 既存の手動取込コア
 *   processRegistryPdf に流し込む（Mode A: path の {id} 物件を直接更新）。
 *
 * route.ts（POST handler）は認証・権限・入力受け口だけを担当し、本ファイルに
 *   - 課金 confirm 必須（confirmed:true 以外は実行しない）
 *   - 物件スコープ（canAccessPropertyRecord）
 *   - registryStatus 二重取得ガード（version 楽観ロックで scheduled 化）
 *   - provider 取得 → processRegistryPdf 接続
 *   - 成功時 obtained / 失敗時は元の status へロック解除
 *   - 非PII AuditLog
 * を集約する。手動取込（processRegistryPdf）の保存・Attachment(registry)・AuditLog 方針を
 * そのまま再利用し、新しい PII 保存先は増やさない。
 *
 * 今回は **mock provider のみ**。実 provider（外部サービス接続・Playwright・認証情報・課金・
 * env 追加）は一切実装しない。CodexP1: provider は呼び出し側が必ず明示注入する（既定値なし）。
 * live route は実 provider 未実装のため getRegistryFetchProvider() が null を返し、route が
 * 501 で安全停止する（mock は本番では使わず、テストでのみ runRegistryAutoFetch に注入する）。
 */
import type { RegistryStatus } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  processRegistryPdf,
  type RegistryPdfSession,
} from "@/lib/registry-pdf/process";
import {
  RegistryFetchError,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
} from "@/lib/registry-fetch";
import {
  createOfficialRegistryProvider,
  type RegistryBrowserFactory,
  type RegistryBrowserPage,
} from "@/lib/registry-fetch/official-provider";
import {
  createRegistryFetchThrottle,
  type RegistryFetchThrottle,
} from "@/lib/registry-fetch/throttle";

export interface RunRegistryAutoFetchArgs {
  /** 認証済みセッション（route の getApiSession から id/role のみ）。 */
  session: RegistryPdfSession;
  /** 取得対象物件ID（route path の {id}）。 */
  propertyId: string;
  /** 課金を伴う操作のため明示確認フラグ。true 以外は実行しない。 */
  confirmed: boolean;
  /**
   * 取得キーの上書き（所在検索で server 側再解決した候補の不動産番号／cond③）。
   * 指定時はこれを fetchRegistryPdf に使う（物件は番号未保持のため）。未指定は物件の realEstateNumber。
   */
  realEstateNumber?: string | null;
}

// provider 失敗（RegistryFetchError）の分類コード → 安全な HTTP ステータス。
// 外部レスポンス本文・認証情報・PII は載せず、分類のみで応答する。
const PROVIDER_ERROR_STATUS: Readonly<Record<RegistryFetchErrorCode, number>> = {
  timeout: 504,
  rate_limited: 429,
  auth_failed: 502,
  // 業務的 not found（対象謄本が存在しない）。upstream 障害（502）と区別し 404 を返す。
  // 502 だとクライアント/呼び出し側が「一時的な upstream 障害 → リトライ」と誤認しうるため。
  not_found: 404,
  provider_error: 502,
};

/**
 * registryStatus を scheduled から元の値へ best-effort で戻す（ロック解除）。
 * まだ scheduled のときだけ戻し、並行更新を踏まない。解除失敗は握りつぶす
 * （元のエラーを優先するため）。
 */
async function releaseSchedulingLock(
  propertyId: string,
  previousStatus: RegistryStatus,
): Promise<void> {
  try {
    await prisma.property.updateMany({
      where: { id: propertyId, registryStatus: "scheduled" },
      data: { registryStatus: previousStatus },
    });
  } catch {
    // ロック解除失敗は記録のみ（元のエラーを優先）。
  }
}

/**
 * provider 解決のオプション。呼び出し側（PR-2 / テスト）が browserFactory を注入するための境界。
 * 本番 route / me-permissions は引数なしで呼ぶため、PR-1 では常に readiness=false（後述）。
 */
export interface ResolveRegistryFetchProviderOptions {
  /**
   * 実ブラウザ（Playwright）を起動する readiness の実体。これが渡されて初めて
   * 「実際に実取得が可能」= provider 解決可能とみなす。PR-2 でここに実 adapter を配線する。
   */
  browserFactory?: RegistryBrowserFactory;
}

// ---------------------------------------------------------------------------
// PR-2: 実 Playwright adapter（公式「登記情報提供サービス」の自動操作）。
//
// ★ Playwright バンドル混入防止の契約（C-1）:
//   Playwright は **defaultChromiumLoader 内の動的 import でのみ** 読み込む。auto-fetch.ts /
//   official-provider.ts は playwright を **静的 import / require しない**（source-assertion で固定）。
//   動的 import は文字列変数経由にして tsc のモジュール解決と webpack のバンドルを回避する
//   （next.config の serverExternalPackages にも "playwright" を加えて二重に external 化）。
// ---------------------------------------------------------------------------

/** Playwright Download の最小ローカル型（静的 import / 型依存しない）。 */
interface RegistryDownloadLike {
  createReadStream(): Promise<RegistryReadableLike | null> | RegistryReadableLike | null;
}
interface RegistryReadableLike {
  on(event: string, listener: (arg?: unknown) => void): unknown;
}
/** Playwright Page の、本 adapter が使う最小サブセット。 */
interface RegistryPageLike {
  setDefaultTimeout?(ms: number): void;
  goto(url: string, options?: unknown): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: unknown): Promise<unknown>;
  waitForEvent(event: string, options?: unknown): Promise<RegistryDownloadLike>;
}
interface RegistryContextLike {
  newPage(): Promise<RegistryPageLike>;
  close(): Promise<void>;
}
interface RegistryBrowserLike {
  newContext(options?: unknown): Promise<RegistryContextLike>;
  close(): Promise<void>;
}
interface RegistryChromiumLike {
  chromium: { launch(options?: unknown): Promise<RegistryBrowserLike> };
}

/**
 * 公式サービスの DOM セレクタ/パス。**実サイトの値は実ログイン環境でのみ確定**するため、
 * 本 PR は枠組み + プレースホルダ定数で集約し、live 投入時にキャリブレーションする（TODO(calibrate)）。
 * いずれも非PII・非secret。
 */
/**
 * 公式「登記情報提供サービス」の documented default base URL。
 *
 * REGISTRY_FETCH_BASE_URL を省略した場合（.env.example に「省略時は provider 既定を使う」と
 * 明記）に login の goto がここを前置する。これが無いと相対 "/login" へ遷移して即 auth_failed に
 * なる（CodexP2: relative URL bug）。env example の記述と実装をこの定数で一致させる。
 * 非PII・非secret（公開された公式サービスの URL）。実サイトの最終パス/サブドメインは
 * live キャリブレーション時に REGISTRY_FETCH_BASE_URL で上書きできる（既定は安全側の表玄関）。
 */
export const DEFAULT_REGISTRY_BASE_URL = "https://www1.touki.or.jp";

/**
 * ログインページの既定パス（base URL に前置する相対パス）。
 *
 * CodexP2: 実サービスの正確な login エンドポイントは実ログイン環境でのみ確証できるため、
 * 既定値（"/login"）を **誤った固定値として確定しない**。live キャリブレーション時は
 * REGISTRY_FETCH_LOGIN_PATH（env）でこのパスを上書きできるようにし、確証後にこの定数へ
 * 反映する運用とする（TODO(calibrate): 実サイトの login パス/URL を確認して確定）。
 * 非PII・非secret（公開された公式サービスのパス）。
 */
export const DEFAULT_REGISTRY_LOGIN_PATH = "/login";

const REGISTRY_SELECTORS = {
  loginId: "#login-id", // TODO(calibrate): 実サイトの入力欄に合わせる
  password: "#login-password", // TODO(calibrate)
  loginSubmit: "button[type=submit]", // TODO(calibrate)
  loggedIn: "#mypage", // TODO(calibrate): ログイン成功を示す固有要素
  searchInput: "#real-estate-number", // TODO(calibrate)
  searchSubmit: "#search-submit", // TODO(calibrate)
  searchResult: "#registry-result", // TODO(calibrate): 謄本ヒットを示す要素
  downloadButton: "#download-pdf", // TODO(calibrate)
} as const;

/**
 * CodexP1: REGISTRY_SELECTORS が **実サイトに校正済み** だと運用者が明示宣言したかを判定する。
 *
 * 上記セレクタは TODO プレースホルダ（"/login" path 以外は env で上書きできない）。資格情報 +
 * opt-in（REGISTRY_FETCH_PROVIDER=official）だけで本番経路の provider を有効化すると、誤った
 * セレクタのまま実サイト（公式「登記情報提供サービス」）を自動操作し、ログイン/検索の途中で必ず
 * 失敗する有料 capability を「設定済み」として露出してしまう。これを防ぐため、本番経路では
 * **明示の校正フラグ REGISTRY_FETCH_SELECTORS_CALIBRATED="true"** が無い限り readiness=false
 * （= getRegistryFetchProvider() が null = route 501 維持）とする。実サイトでセレクタを校正し
 * コード定数へ反映した後に、runbook 手順でこのフラグを立てて初めて有効化する運用。
 * 値は明示の "true" のみ受理（"1"/"yes" 等は不可＝誤設定での意図せぬ有効化を避ける）。非PII・非secret。
 */
function areRegistrySelectorsCalibrated(): boolean {
  return process.env.REGISTRY_FETCH_SELECTORS_CALIBRATED === "true";
}

function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "TimeoutError"
  );
}

/**
 * 生 Playwright Page を RegistryBrowserPage（高水準セッション抽象）へ適合させる adapter。
 * 失敗は **RegistryFetchError（分類コードのみ）** に正規化し、生メッセージ（URL/入力/selector が
 * 混入しうる）を例外に載せない。中間成果物（Cookie/DL）は close() で破棄する。
 */
function createPlaywrightRegistryPage(
  handles: {
    browser: RegistryBrowserLike;
    context: RegistryContextLike;
    page: RegistryPageLike;
  },
  config: { loginPath: string } = { loginPath: DEFAULT_REGISTRY_LOGIN_PATH },
): RegistryBrowserPage {
  const { browser, context, page } = handles;
  const { loginPath } = config;
  return {
    async login(input) {
      try {
        // baseUrl 省略時は documented default を用いる（相対 "/login" 遷移を防ぐ）。
        // loginPath は env（REGISTRY_FETCH_LOGIN_PATH）で上書き可能（live キャリブレーション）。
        const base = input.baseUrl ?? DEFAULT_REGISTRY_BASE_URL;
        await page.goto(`${base}${loginPath}`);
        await page.fill(REGISTRY_SELECTORS.loginId, input.loginId);
        await page.fill(REGISTRY_SELECTORS.password, input.password);
        await page.click(REGISTRY_SELECTORS.loginSubmit);
        // ログイン成功を固有要素で確認（URL だけで判定しない）。
        await page.waitForSelector(REGISTRY_SELECTORS.loggedIn);
      } catch {
        // ログイン確認に至らない = 認証失敗扱い（生メッセージ非載・secret 非露出）。
        throw new RegistryFetchError("auth_failed");
      }
    },
    async searchByRealEstateNumber(realEstateNumber) {
      // CodexP2: timeout を「provider 連携の不具合（リトライ可能）」と「真の結果なし（not_found）」で
      // 弁別する。
      //   - fill/click（フォーム入力・送信のセットアップ段）由来の TimeoutError は
      //     セレクタ校正ズレ/ページ未準備（= 連携不備）→ provider_error。
      //   - 結果待ち（waitForSelector）の TimeoutError は「検索ページが遅い/セレクタ変更/結果行が
      //     描画される前のタイムアウト」を意味し、**「謄本が存在しない」ではない**。これを
      //     found:false（→ not_found 404）と誤分類するとリトライ/監視を誤誘導し、一時的な障害を
      //     偽陰性（該当なし）にしてしまう。よって timeout 系（RegistryFetchError("timeout")）へ
      //     分類し、真の「結果なし」とは区別する。
      //   - 真の「結果なし」（明示の no-result インジケータ）の検出は live キャリブレーションで
      //     導入し、その経路でのみ found:false（→ not_found）を返す（TODO(calibrate)）。
      // いずれも生メッセージ（selector/入力が混入しうる）は例外に載せない。
      try {
        await page.fill(REGISTRY_SELECTORS.searchInput, realEstateNumber);
        await page.click(REGISTRY_SELECTORS.searchSubmit);
      } catch {
        // セットアップ（fill/click）由来の失敗は timeout 含め provider_error 扱い。
        throw new RegistryFetchError("provider_error");
      }
      try {
        await page.waitForSelector(REGISTRY_SELECTORS.searchResult);
        return { found: true };
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        // 結果待ちの TimeoutError は連携不備（リトライ可能）= timeout。not_found にしない。
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
        // それ以外（非 timeout の生例外）は provider_error。
        throw new RegistryFetchError("provider_error");
      }
    },
    async downloadRegistryPdf() {
      try {
        // download イベントの待受を click より先に張る（Playwright 推奨）。
        const [download] = await Promise.all([
          page.waitForEvent("download", {}),
          page.click(REGISTRY_SELECTORS.downloadButton),
        ]);
        const stream = await download.createReadStream();
        if (!stream) {
          throw new RegistryFetchError("provider_error");
        }
        return await readStreamToBuffer(stream);
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
        throw new RegistryFetchError("provider_error");
      }
    },
    async close() {
      // best-effort: context → browser を確実に閉じ、Cookie/セッション/DL を残さない。
      try {
        await context.close();
      } catch {
        // swallow
      }
      try {
        await browser.close();
      } catch {
        // swallow
      }
    },
  };
}

/** Download stream を Buffer に集約する（HTTP クライアント呼び出しを使わない＝source-assertion 準拠）。 */
function readStreamToBuffer(stream: RegistryReadableLike): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk as Uint8Array));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * 実 Playwright を読み込む動的ローダ（C-1: ここだけが playwright を読む）。
 * 文字列変数経由の動的 import で tsc のモジュール解決と webpack のバンドルを回避する。
 */
async function defaultChromiumLoader(): Promise<RegistryChromiumLike> {
  const moduleId = "playwright";
  return (await import(/* webpackIgnore: true */ moduleId)) as RegistryChromiumLike;
}

/**
 * 本番（引数なし呼び出し）/ テスト（chromiumLoader 注入）で使う browserFactory を解決する。
 *
 * readiness 設計（CodexP2 を維持しつつ PR-2 で live 化）:
 *   - **本番経路（chromiumLoader 未注入）**: 次の **両方** が揃って初めて factory を返す。
 *       (a) 明示 opt-in `REGISTRY_FETCH_PROVIDER==="official"`（chromium 配置済みの運用宣言）
 *       (b) CodexP1 セレクタ校正フラグ `REGISTRY_FETCH_SELECTORS_CALIBRATED==="true"`
 *     いずれか欠ければ undefined（= getRegistryFetchProvider() が null = route 501 維持 = 本番挙動
 *     不変。現本番は当 env 未設定）。これにより「資格情報だけ設定して playwright/chromium 未配置」
 *     や「セレクタが TODO プレースホルダのまま」でも capability=true で常に失敗する操作（誤セレクタ
 *     での実サイト操作）を露出しない（runbook で chromium 配置 + セレクタ校正後に両 env を立てる運用）。
 *   - **テスト経路（chromiumLoader 注入）**: opt-in/校正 env なしでも factory を返す（実 playwright を
 *     読み込まず注入 chromium で adapter を検証するため）。
 *
 * ★ C-1: playwright は defaultChromiumLoader 内の動的 import でのみ読む（静的 import / require なし）。
 */
export function resolveDefaultRegistryBrowserFactory(
  deps: { chromiumLoader?: () => Promise<RegistryChromiumLike> } = {},
): RegistryBrowserFactory | undefined {
  // 本番経路は明示 opt-in + セレクタ校正フラグの両方を要求（テスト注入時は不要）。
  // CodexP1: 校正フラグ無し（TODO プレースホルダのまま）の opt-in では誤セレクタで実サイトを
  //   操作してしまうため、有効化せず undefined を維持する（= 501 維持）。
  if (
    !deps.chromiumLoader &&
    (process.env.REGISTRY_FETCH_PROVIDER !== "official" ||
      !areRegistrySelectorsCalibrated())
  ) {
    return undefined;
  }
  const load = deps.chromiumLoader ?? defaultChromiumLoader;
  const timeoutRaw = process.env.REGISTRY_FETCH_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  // CodexP2: login パスは env（REGISTRY_FETCH_LOGIN_PATH）で上書き可能（誤った固定値で確定しない）。
  //   未設定なら DEFAULT_REGISTRY_LOGIN_PATH（"/login"・TODO(calibrate)）。非PII・非secret。
  const loginPath =
    process.env.REGISTRY_FETCH_LOGIN_PATH || DEFAULT_REGISTRY_LOGIN_PATH;

  return async () => {
    const { chromium } = await load();
    // CodexP2: launch 成功後に newContext/newPage が reject すると、起動済みの
    //   browser（さらに context）が close されず Chromium プロセスがリークする。
    //   セットアップ段の部分失敗では、生成済みハンドルを best-effort で確実に閉じてから
    //   元の起動エラーを rethrow する（provider 側 classifyRegistryFetchError が
    //   生メッセージを provider_error へ正規化する契約は不変）。
    const browser = await chromium.launch({ headless: true });
    let context: RegistryContextLike;
    try {
      context = await browser.newContext({ acceptDownloads: true });
    } catch (err) {
      await closeQuietly(browser);
      throw err;
    }
    let page: RegistryPageLike;
    try {
      page = await context.newPage();
    } catch (err) {
      await closeQuietly(context);
      await closeQuietly(browser);
      throw err;
    }
    if (timeoutMs && Number.isFinite(timeoutMs) && page.setDefaultTimeout) {
      page.setDefaultTimeout(timeoutMs);
    }
    return createPlaywrightRegistryPage({ browser, context, page }, { loginPath });
  };
}

/** close を best-effort で呼ぶ（部分失敗時のリソース解放・close 例外は握りつぶす）。 */
async function closeQuietly(
  handle: { close(): Promise<void> } | undefined,
): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // swallow: 元の起動エラーを優先する（close 失敗で握り直さない）。
  }
}

/**
 * 本番レート制御 throttle の共有シングルトン（CodexP2）。
 *
 * getRegistryFetchProvider() が呼ばれるたびに throttle を作り直すと、別リクエスト由来の
 * 別 provider インスタンスが各々独立した throttle を持ち、同時 POST が公式サービスへ複数
 * 同時アクセスしてしまう（約款第12条の2: 過度な検索回避が効かない）。単一 Node プロセス
 * 前提（本番 VPS）でプロセス全体に 1 つの throttle を共有し、provider をまたいで直列化する。
 *
 * 最小間隔は REGISTRY_FETCH_MIN_INTERVAL_MS（.env.example に記載）から読む。未設定なら
 * createRegistryFetchThrottle の保守的既定（60_000ms = 1 件/分）。throttle は token-bucket の
 * 純粋ラッパで nowMs を引数で受けるため、provider 側の now() 注入と整合する。
 */
let sharedRegistryFetchThrottle: RegistryFetchThrottle | undefined;

function getSharedRegistryFetchThrottle(): RegistryFetchThrottle {
  if (!sharedRegistryFetchThrottle) {
    const raw = process.env.REGISTRY_FETCH_MIN_INTERVAL_MS;
    const parsed = raw ? Number(raw) : undefined;
    const minIntervalMs =
      parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    sharedRegistryFetchThrottle = createRegistryFetchThrottle(
      minIntervalMs ? { minIntervalMs } : {},
    );
  }
  return sharedRegistryFetchThrottle;
}

/**
 * テスト専用: 共有 throttle シングルトンを破棄する（プロセス内状態がテスト間で漏れないように）。
 * 本番経路からは呼ばない。
 */
export function __resetRegistryFetchThrottleForTest(): void {
  sharedRegistryFetchThrottle = undefined;
}

/**
 * 本番で使用する謄本取得 provider を解決する。
 *
 * CodexP1: env フラグで provider を切替えず、資格情報（REGISTRY_FETCH_LOGIN_ID/PASSWORD）で解決する。
 * CodexP2: さらに **readiness（browserFactory の有無 = 実取得が実際に可能か）** を解決条件に加える。
 *   - 資格情報が揃い かつ readiness（browserFactory）が揃って初めて実 provider を返す。
 *   - いずれか欠ければ null（= route 501 維持）。throw でなく null を返し、既存の 501 null 契約を
 *     温存する（住所補完 resolveProvider() は 503 throw だが、registry は 501 null 契約を変えない）。
 *
 * 秘密管理: REGISTRY_FETCH_* は **この関数内でのみ** 読む（server-side のみ・NEXT_PUBLIC 禁止）。
 *
 * PR-1 scaffold の安全性: 本番は引数なしで呼ぶ → readiness（browserFactory）は
 * resolveDefaultRegistryBrowserFactory() が undefined を返す（PR-1 では実 adapter 未配線）→ 常に
 * null = 501 維持で本番挙動は不変（env を設定しても scheduled にせず・有料ボタンも無効）。
 * PR-2 で resolveDefaultRegistryBrowserFactory() に実 adapter を入れる（または呼び出し側が
 * browserFactory を注入する）と、env が揃った時点で capability=true になる。
 */
export function getRegistryFetchProvider(
  options: ResolveRegistryFetchProviderOptions = {},
): RegistryFetchProvider | null {
  const loginId = process.env.REGISTRY_FETCH_LOGIN_ID;
  const password = process.env.REGISTRY_FETCH_PASSWORD;

  // 資格情報のいずれか欠落 → null（= route 501 維持 = 本番挙動不変）。
  if (!loginId || !password) {
    return null;
  }

  // CodexP2: readiness（browserFactory）が無ければ実取得不能 → null（= 501 維持）。
  // PR-1 では default factory が undefined ゆえ、env 設定済みでもここで null になる。
  const browserFactory =
    options.browserFactory ?? resolveDefaultRegistryBrowserFactory();
  if (!browserFactory) {
    return null;
  }

  const baseUrl = process.env.REGISTRY_FETCH_BASE_URL || undefined;
  const timeoutRaw = process.env.REGISTRY_FETCH_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;

  // C-1: value import の boundary を factory に薄く包む。createOfficialRegistryProvider /
  // OfficialRegistryProvider はいずれも playwright を静的 import しないため、この value import
  // 連鎖（auto-fetch → me/permissions route）で Playwright はバンドルへ混入しない。
  //
  // CodexP2: 本番 provider に共有 throttle（REGISTRY_FETCH_MIN_INTERVAL_MS）を配線する。
  //   これが無いと live route の同時 POST がレート制御をすり抜けて公式へ複数同時アクセスして
  //   しまう。プロセス全体で 1 つの throttle を共有し、provider をまたいで直列化する。
  return createOfficialRegistryProvider({
    loginId,
    password,
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    browserFactory,
    throttle: getSharedRegistryFetchThrottle(),
  });
}

/**
 * UI の capability 表示用 read-only ヘルパ。本番 provider が解決できるか（= 設定済み かつ
 * 実取得可能 = readiness 充足か）を boolean だけで返す。secret・設定値そのもの・PII は返さない。
 * 副作用・外部接続・env 追加なし。
 *
 * CodexP2: env 設定済みでも browserFactory 未配線（PR-1）なら false を返す。これにより
 * /api/me/permissions の capabilities.registryAutoFetch が false となり、有料の自動取得ボタンは
 * 無効・POST は 501 維持となる（「設定済みなのに常に失敗する操作」を露出しない）。
 */
export function isRegistryAutoFetchProviderConfigured(
  options: ResolveRegistryFetchProviderOptions = {},
): boolean {
  return getRegistryFetchProvider(options) != null;
}

/**
 * 所在検索（番号無し物件を所在で検索して取得）が「この環境で使えるか」を boolean で返す。
 * 自動取得より厳しく、provider が `supportsLocationSearch === true` を宣言している場合のみ true。
 *
 * CodexP2: official provider は searchByLocation 未実装ゆえ supportsLocationSearch を宣言しない。
 * 自動取得は可能でも所在検索は未対応、という状態で「所在で謄本を検索」ボタンを出して確認後に必ず
 * 501 で失敗する UI を露出しないため、search route の 501 条件（supportsLocationSearch===true）と
 * 揃えた専用 capability にする。
 */
export function isRegistryLocationSearchConfigured(
  options: ResolveRegistryFetchProviderOptions = {},
): boolean {
  return getRegistryFetchProvider(options)?.supportsLocationSearch === true;
}

/**
 * 自動取得の中核。route から呼ばれ、戻り値がそのまま API レスポンス body になる。
 * ハードエラーは ApiError を throw し、route 側 catch → handleApiError で HTTP 化する。
 *
 * CodexP1: provider は呼び出し側が必ず明示注入する（既定値なし）。これにより live route が
 * provider を渡さずに mock を暗黙利用して本番 DB を壊すことを型レベルで防ぐ。
 */
export async function runRegistryAutoFetch(
  args: RunRegistryAutoFetchArgs,
  provider: RegistryFetchProvider,
): Promise<Record<string, unknown>> {
  const { session, propertyId, confirmed } = args;

  // 1. 課金 confirm 必須（true 以外は一切実行しない）。
  if (confirmed !== true) {
    throw new ApiError(
      400,
      "謄本自動取得には確認（confirmed:true）が必要です",
      "REGISTRY_AUTO_FETCH_CONFIRMATION_REQUIRED",
    );
  }

  // 2. 対象物件の取得（非PIIの最小カラムのみ）。
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      createdBy: true,
      assignedTo: true,
      registryStatus: true,
      version: true,
      realEstateNumber: true,
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }

  // 3. 物件スコープ（field_staff は担当/作成物件のみ）。既存 Mode A と同じ 403 方針。
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(
      403,
      "この物件にアクセスする権限がありません",
      "FORBIDDEN",
    );
  }

  // 4. 二重取得ガード（早期）: 既に scheduled なら 409。
  if (property.registryStatus === "scheduled") {
    throw new ApiError(
      409,
      "この物件は既に謄本自動取得を実行中です",
      "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    );
  }

  // 5. 楽観ロック取得: version 一致 かつ まだ scheduled でない物件だけを scheduled にする。
  //    count===0 は並行取得 or バージョン変化 → 409（二重実行させない）。
  const previousStatus = property.registryStatus;
  const lock = await prisma.property.updateMany({
    where: {
      id: propertyId,
      version: property.version,
      registryStatus: { not: "scheduled" },
    },
    data: { registryStatus: "scheduled", version: { increment: 1 } },
  });
  if (lock.count === 0) {
    throw new ApiError(
      409,
      "この物件は既に謄本自動取得を実行中です",
      "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    );
  }

  // 6. provider 取得 → PDF 検証 → text 抽出 → processRegistryPdf 接続 → 成功 status。
  //    いずれの失敗でも scheduled で固着させないよう、catch で必ずロック解除する。
  try {
    // 取得キーは非PIIのみ（realEstateNumber / 物件UUID）。所有者名・住所は渡さない。
    // cond③: 所在検索の候補取得では server 再解決した override を優先（物件は番号未保持）。
    const fetchResult = await provider.fetchRegistryPdf({
      realEstateNumber: args.realEstateNumber ?? property.realEstateNumber,
      ref: property.id,
    });

    // 取得物が PDF でなければ取込に進まない（real provider 差し替え時の防御）。
    if (!isPdfBuffer(fetchResult.pdfBuffer)) {
      throw new ApiError(
        422,
        "取得した謄本がPDFではありません",
        "REGISTRY_AUTO_FETCH_INVALID_PDF",
      );
    }

    // 手動 multipart 取込と同じ抽出器を使う（pdf-parse）。
    let text: string;
    try {
      text = await extractTextFromPdf(fetchResult.pdfBuffer);
    } catch {
      throw new ApiError(
        422,
        "取得した謄本PDFのテキスト抽出に失敗しました",
        "REGISTRY_AUTO_FETCH_PDF_PARSE_FAILED",
      );
    }

    // 既存の手動取込コアへ接続（Mode A: 対象物件を直接更新）。ImportJob 作成・
    // Attachment(type="registry") 保存・pdf_import AuditLog（非PII）は processRegistryPdf
    // 側の既存方針をそのまま再利用する（新しい PII 保存先は増やさない）。
    const result = await processRegistryPdf({
      session,
      text,
      propertyId,
      fileName: fetchResult.fileName,
      edited: undefined,
      pdfBuffer: fetchResult.pdfBuffer,
    });

    // 成功 → scheduled から obtained へ確定。
    await prisma.property.update({
      where: { id: propertyId },
      data: { registryStatus: "obtained", version: { increment: 1 } },
    });

    // 成功 AuditLog（非PII のみ）。PDF本文/抽出テキスト/所有者名・住所/郵便番号/
    // fileUrl 全文/APIキー/credential/raw レスポンスは載せない。件数・ID・分類のみ。
    await writeAuditLog({
      userId: session.id,
      action: "registry_auto_fetch",
      targetTable: "properties",
      targetId: propertyId,
      detail: {
        propertyId,
        jobId: result.jobId,
        ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
        source: fetchResult.source,
        providerRequestId: fetchResult.providerRequestId,
        fetchedAt: fetchResult.fetchedAt.toISOString(),
        status: "success",
        action: result.action,
        ownersMatched: result.ownersMatched ?? 0,
        ownersCreated: result.ownersCreated ?? 0,
        ownersLinked: result.ownersLinked ?? 0,
        confirmed: true,
      },
    });

    // レスポンス body（非PII の allowlist）。
    // CodexP2: processRegistryPdf の戻り値 result には parsed（謄本由来の owner 名・住所・
    // realEstateNumber 等の PII）が含まれる。本 API は registry:auto_fetch + property:read で
    // 実行でき owner:read を要求しないため、result を spread して parsed を返すと既存の
    // owner:read 制御（物件詳細 API の owner PII マスキング）を迂回して owner PII を漏らす。
    // よって result は spread せず、非PII の項目だけを明示的に拾って返す。所有者名/住所/
    // 郵便番号/抽出テキスト/PDF本文/fileUrl 全文は返さない（手動取込APIのレスポンスは不変）。
    return {
      jobId: result.jobId,
      action: result.action,
      status: "success",
      propertyId: result.propertyId,
      ownersMatched: result.ownersMatched,
      ownersCreated: result.ownersCreated,
      ownersLinked: result.ownersLinked,
      ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
      source: fetchResult.source,
      fileName: fetchResult.fileName,
      providerRequestId: fetchResult.providerRequestId,
      fetchedAt: fetchResult.fetchedAt.toISOString(),
      registryStatus: "obtained",
      confirmed: true,
    };
  } catch (err) {
    // 失敗 → ロック解除（previousStatus へ戻す）。best-effort・元のエラー優先。
    await releaseSchedulingLock(propertyId, previousStatus);

    // provider 失敗は安全なレスポンスにマップ（分類コードのみ・PII/認証情報/生レスポンスなし）。
    if (err instanceof RegistryFetchError) {
      // 失敗 AuditLog（非PII: 分類コードのみ）。
      await writeAuditLog({
        userId: session.id,
        action: "registry_auto_fetch",
        targetTable: "properties",
        targetId: propertyId,
        detail: {
          propertyId,
          source: provider.name,
          status: "failed",
          providerErrorCode: err.code,
          confirmed: true,
        },
      });
      throw new ApiError(
        PROVIDER_ERROR_STATUS[err.code],
        err.message,
        "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
      );
    }

    // それ以外（extract 失敗の ApiError(422) / processRegistryPdf の ApiError / Prisma 例外）は
    // そのまま再 throw して route の handleApiError に正規の HTTP を返させる。
    throw err;
  }
}
