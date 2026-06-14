/**
 * 謄本自動取得 — 公式「登記情報提供サービス」provider（PR-2 実フロー）。
 *
 * 路線: 民間 API 代行を挟まず、公式サービス（公開 API なし・ログイン付き Web のみ）を
 * ヘッドレスブラウザ（Playwright）で自動操作して謄本 PDF を取得する。
 *
 * 本ファイルの責務は **フロー制御とエラー分類のみ**。サイト固有の DOM 操作（Playwright の
 * 生 API）は呼び出し側 auto-fetch.ts の adapter（resolveDefaultRegistryBrowserFactory が
 * 生成する RegistryBrowserPage 実体）に閉じ込める。本 provider からは RegistryBrowserPage
 * interface しか見えないため、route / orchestrator は無改変で差し替え可能。
 *
 * 秘密管理: loginId / password は constructor options でのみ受け取り、戻り値
 *   （RegistryFetchResult）・例外（RegistryFetchError は分類コードのみ）・ログに一切載せない。
 *   未分類の例外（Playwright の生メッセージ＝URL/入力が混入しうる）は必ず provider_error に
 *   潰してから上位へ返す（生メッセージを例外に乗せない）。
 *
 * PII: input は非PII の realEstateNumber / ref のみ（既存 RegistryFetchRequest 制約）。
 *   PR-2 は **不動産番号がある物件に限定**（realEstateNumber 空 → not_found）。所在系
 *   （地番/家屋番号/所在＝PII 性）での検索は PR-2b（契約拡張・別 PII 評価）に分離する。
 *   スクショ/HTML/Cookie/セッション等の中間成果物は adapter 側で永続しない・即破棄。
 *
 * ★ Playwright バンドル混入防止の契約（C-1）:
 *   本ファイルは playwright を **静的 import / require しない**（source-assertion テストで固定）。
 *   実ブラウザ（Playwright）の読み込みは、呼び出し側 auto-fetch.ts の
 *   resolveDefaultRegistryBrowserFactory() 内の **動的 import** にのみ閉じ込める契約とする。
 */
import type {
  RegistryFetchProvider,
  RegistryFetchRequest,
  RegistryFetchResult,
} from "./types";
import { RegistryFetchError } from "./errors";
import type { RegistryFetchThrottle } from "./throttle";

/** login に渡す資格情報＋遷移先（page 側に保持させない＝呼び出し都度渡す契約）。 */
export interface RegistryLoginInput {
  loginId: string;
  password: string;
  baseUrl?: string;
}

/** 不動産番号検索の結果。found=false なら provider は not_found を投げる。 */
export interface RegistrySearchOutcome {
  found: boolean;
}

/**
 * 高水準ブラウザ抽象（PR-2）。Playwright の生 API を直接型依存しないための seam。
 * 実体（chromium で起動した page を本 interface に適合させる adapter）は auto-fetch.ts 側で
 * 生成する。各メソッドは失敗時に **RegistryFetchError（分類コードのみ）** を投げる契約
 * （auth_failed / not_found / rate_limited / timeout / provider_error）。
 */
export interface RegistryBrowserPage {
  /** 公式サービスへログイン。失敗は RegistryFetchError("auth_failed")。 */
  login(input: RegistryLoginInput): Promise<void>;
  /** 不動産番号で謄本検索。ヒットしなければ found:false。 */
  searchByRealEstateNumber(
    realEstateNumber: string,
  ): Promise<RegistrySearchOutcome>;
  /** 検索ヒット後、謄本PDFを取得して Buffer で返す。 */
  downloadRegistryPdf(): Promise<Buffer>;
  /** ページ/コンテキスト/ブラウザを閉じて中間成果物を破棄する（best-effort）。 */
  close(): Promise<void>;
}

/**
 * ブラウザ（ページ）を 1 取得分だけ生成するファクトリ。
 * テストでは実ブラウザを起動しない fake page を注入する。本番は auto-fetch.ts の
 * resolveDefaultRegistryBrowserFactory() が実 Playwright adapter を返す。
 */
export type RegistryBrowserFactory = () => Promise<RegistryBrowserPage>;

export interface OfficialRegistryProviderOptions {
  /** 公式サービスのログイン ID（利用者識別番号）。server-side のみ・非ログ・非返却。 */
  loginId: string;
  /** 公式サービスのログイン PW。server-side のみ・非ログ・非返却。 */
  password: string;
  /** 公式サービスのベース URL（login に渡す）。 */
  baseUrl?: string;
  /** 1 取得のタイムアウト（ミリ秒）。指定時はフロー全体を Promise.race で打ち切る。 */
  timeoutMs?: number;
  /**
   * ブラウザ生成ファクトリ（注入境界）。
   * 未注入なら外部接続不能 = 未設定扱いで provider_error（fail-closed）。
   */
  browserFactory?: RegistryBrowserFactory;
  /**
   * レート制御（約款第12条の2: 過度な検索回避）。取得前に 1 件分の許可を試み、
   * 拒否なら **公式へアクセスする前に** rate_limited で停止する。
   */
  throttle?: RegistryFetchThrottle;
  /** fetchedAt / throttle の現在時刻をテストから固定するための注入（未指定なら実時刻）。 */
  now?: () => Date;
  /** providerRequestId をテストから固定/生成するための注入（非PII）。 */
  requestIdFactory?: () => string;
}

/** 未分類の例外を provider_error に潰す（生メッセージ＝secret/PII を例外に載せない）。 */
function classifyRegistryFetchError(err: unknown): RegistryFetchError {
  if (err instanceof RegistryFetchError) return err;
  // Playwright 等の生エラー（URL/入力/selector が混入しうる）は分類コードのみへ正規化。
  return new RegistryFetchError("provider_error");
}

/**
 * 公式サービス provider。RegistryFetchProvider に準拠する。
 *
 * fetchRegistryPdf:
 *   throttle 許可 → realEstateNumber 必須（PR-2: 不動産番号限定）→ browserFactory で page 生成
 *   → login → 不動産番号検索 → PDF DL → RegistryFetchResult。失敗は RegistryFetchError に
 *   分類し、いずれの経路でも finally で page.close()（中間成果物破棄）。
 */
export class OfficialRegistryProvider implements RegistryFetchProvider {
  readonly name = "official";

  private readonly loginId: string;
  private readonly password: string;
  private readonly baseUrl?: string;
  private readonly timeoutMs?: number;
  private readonly browserFactory?: RegistryBrowserFactory;
  private readonly throttle?: RegistryFetchThrottle;
  private readonly now: () => Date;
  private readonly requestIdFactory: () => string;

  constructor(options: OfficialRegistryProviderOptions) {
    this.loginId = options.loginId;
    this.password = options.password;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.browserFactory = options.browserFactory;
    this.throttle = options.throttle;
    this.now = options.now ?? (() => new Date());
    this.requestIdFactory =
      options.requestIdFactory ??
      (() => `official-${Math.random().toString(36).slice(2, 10)}`);
  }

  async fetchRegistryPdf(
    request: RegistryFetchRequest,
  ): Promise<RegistryFetchResult> {
    // 1. PR-2: 不動産番号がある物件に限定。空なら検索キーが無く取得不能（非PII前提を維持）。
    //    所在系（地番/家屋番号/所在）での検索は PR-2b（契約拡張・別 PII 評価）。
    const realEstateNumber = request.realEstateNumber?.trim();
    if (!realEstateNumber) {
      throw new RegistryFetchError("not_found");
    }

    // 2. レート制御（公式へアクセスする前に判定 = 過剰アクセスを物理的に防ぐ）。
    if (this.throttle && !this.throttle.tryAcquire(this.name, this.now().getTime())) {
      throw new RegistryFetchError("rate_limited");
    }

    // 3. browserFactory 未注入 = 実ブラウザを起動する術がない = 未設定扱い（fail-closed）。
    if (!this.browserFactory) {
      throw new RegistryFetchError("provider_error");
    }

    const requestId = this.requestIdFactory();

    // 4. ブラウザ起動（動的 Playwright import / chromium.launch / newContext / newPage）。
    //    ここでの失敗（依存未導入・起動不能・生エラー＝パス/内部情報が混入しうる）は、
    //    後続の try/catch（classifyRegistryFetchError）に入る前に発生するため、
    //    **この時点で明示的に provider_error へ正規化**して生メッセージの伝播を防ぐ
    //    （RegistryFetchError は分類コードを保ったまま伝播）。page 未生成ゆえ close 不要。
    let page: RegistryBrowserPage;
    try {
      page = await this.browserFactory();
    } catch (err) {
      throw classifyRegistryFetchError(err);
    }

    try {
      const pdfBuffer = await this.withTimeout(async () => {
        await page.login({
          loginId: this.loginId,
          password: this.password,
          baseUrl: this.baseUrl,
        });
        const outcome = await page.searchByRealEstateNumber(realEstateNumber);
        if (!outcome.found) {
          throw new RegistryFetchError("not_found");
        }
        return page.downloadRegistryPdf();
      });

      return {
        pdfBuffer,
        // 非PII の generic filename（不動産番号・所有者名を埋め込まない）。
        fileName: `registry-auto-${requestId}.pdf`,
        source: this.name,
        fetchedAt: this.now(),
        providerRequestId: requestId,
      };
    } catch (err) {
      throw classifyRegistryFetchError(err);
    } finally {
      // 例外経路でも必ず close（Cookie/セッション/DL ファイル等の中間成果物を残さない）。
      try {
        await page.close();
      } catch {
        // close 失敗は握りつぶす（元のエラー / 成功結果を優先）。
      }
    }
  }

  /**
   * timeoutMs 指定時、op をタイムアウト付きで実行する。期限超過は RegistryFetchError("timeout")。
   * 未指定なら op をそのまま await（タイムアウト無し）。
   */
  private withTimeout<T>(op: () => Promise<T>): Promise<T> {
    const timeoutMs = this.timeoutMs;
    if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return op();
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RegistryFetchError("timeout"));
      }, timeoutMs);
      op().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

/**
 * OfficialRegistryProvider を生成する薄い factory（C-1: value import 境界を明確化）。
 *
 * 本ファイルは playwright を静的 import しないため、この factory を value import しても
 * Playwright はバンドルへ混入しない。実 Playwright 起動 adapter（browserFactory）の配線は
 * 呼び出し側（auto-fetch.ts の resolveDefaultRegistryBrowserFactory 内の動的 import）に閉じ込める。
 */
export function createOfficialRegistryProvider(
  options: OfficialRegistryProviderOptions,
): OfficialRegistryProvider {
  return new OfficialRegistryProvider(options);
}
