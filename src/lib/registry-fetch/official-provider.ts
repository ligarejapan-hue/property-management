/**
 * 謄本自動取得 — 公式「登記情報提供サービス」provider の骨格（PR-1 scaffold）。
 *
 * 路線: 民間 API 代行を挟まず、公式サービス（公開 API なし・ログイン付き Web のみ）を
 * ヘッドレスブラウザ（Playwright）で自動操作して謄本 PDF を取得する想定。
 *
 * ★ PR-1 ではここに **実ブラウザ操作・Playwright import・外部接続・実認証を一切書かない。**
 *   - browser を生成する境界（browserFactory）の **型/インターフェースのみ** を定義する。
 *   - browserFactory が **未注入**なら、外部に接続しようがないので「未設定扱い」として
 *     RegistryFetchError("provider_error") を投げて安全に停止する（fail-closed）。
 *   - 実際のログイン・検索・PDF ダウンロードの中身は **PR-2** で browserFactory 経由に実装する。
 *
 * 秘密管理: loginId / password は constructor options でのみ受け取り、
 *   - 戻り値（RegistryFetchResult）・例外（RegistryFetchError は分類コードのみ）・ログに
 *     一切載せない。
 *   - フィールドは private に閉じ込め、provider 外部からは RegistryFetchProvider interface
 *     しか見えない（route / orchestrator は無改変で差し替え可能）。
 *
 * PII: input は非PII の realEstateNumber / ref のみ（既存 RegistryFetchRequest 制約）。
 *   スクショ/HTML/Cookie/セッションなどの中間成果物は永続しない・ログに出さない・即破棄。
 *   PR-1 では中間成果物自体を生成しない（実操作が無いため）。
 */
import type {
  RegistryFetchProvider,
  RegistryFetchRequest,
  RegistryFetchResult,
} from "./types";
import { RegistryFetchError } from "./errors";

/**
 * Playwright を直接型依存しないための最小ブラウザ抽象（PR-1 では型のみ）。
 *
 * 実体（chromium.launch() で起動した Browser を本 interface に適合させる薄い adapter）は
 * PR-2 で実装する。ここで Playwright を import しないことで、PR-1 は playwright 依存を
 * 一切追加せず（package.json 不変）に provider 骨格を確定できる。
 */
export interface RegistryBrowserPage {
  /** 指定 URL へ遷移する。 */
  goto(url: string): Promise<void>;
  /** ページ/ブラウザコンテキストを閉じて中間成果物を破棄する。 */
  close(): Promise<void>;
}

/**
 * ブラウザ（ページ）を 1 取得分だけ生成するファクトリ。
 * テストでも実ブラウザを起動しないよう、呼び出し側（PR-2 / テスト）が注入する。
 * PR-1 では「注入されていなければ未設定扱い」の境界としてのみ使う。
 */
export type RegistryBrowserFactory = () => Promise<RegistryBrowserPage>;

export interface OfficialRegistryProviderOptions {
  /** 公式サービスのログイン ID（利用者識別番号）。server-side のみ・非ログ・非返却。 */
  loginId: string;
  /** 公式サービスのログイン PW。server-side のみ・非ログ・非返却。 */
  password: string;
  /** 公式サービスのベース URL（省略時は実装側の既定を PR-2 で使う）。 */
  baseUrl?: string;
  /** 1 取得のタイムアウト（ミリ秒）。 */
  timeoutMs?: number;
  /**
   * ブラウザ生成ファクトリ（注入境界）。
   * PR-1: 未注入なら外部接続不能 = 未設定扱いで provider_error。
   * PR-2: 実 Playwright 起動 adapter を注入し、ここで実操作を実装する。
   */
  browserFactory?: RegistryBrowserFactory;
  /** fetchedAt をテスト/呼び出し側から固定するための注入（未指定なら取得時刻）。 */
  now?: () => Date;
  /** providerRequestId をテストから固定/生成するための注入（非PII）。 */
  requestIdFactory?: () => string;
}

/**
 * 公式サービス provider。RegistryFetchProvider に準拠する。
 *
 * PR-1 では fetchRegistryPdf の中身は「browserFactory 注入境界の確認」までで、
 * 実ブラウザ操作には到達しない（未注入なら provider_error、注入時も実装は PR-2 で
 * 追加するまで not-implemented として provider_error）。
 */
export class OfficialRegistryProvider implements RegistryFetchProvider {
  readonly name = "official";

  private readonly loginId: string;
  private readonly password: string;
  private readonly baseUrl?: string;
  private readonly timeoutMs?: number;
  private readonly browserFactory?: RegistryBrowserFactory;
  private readonly now: () => Date;
  private readonly requestIdFactory: () => string;

  constructor(options: OfficialRegistryProviderOptions) {
    this.loginId = options.loginId;
    this.password = options.password;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.browserFactory = options.browserFactory;
    this.now = options.now ?? (() => new Date());
    this.requestIdFactory =
      options.requestIdFactory ??
      (() => `official-${Math.random().toString(36).slice(2, 10)}`);
  }

  async fetchRegistryPdf(
    request: RegistryFetchRequest,
  ): Promise<RegistryFetchResult> {
    // PR-1: browserFactory 未注入 = 実ブラウザを起動する術がない = 未設定扱い。
    // 外部に接続しないまま安全に停止する（fail-closed）。
    if (!this.browserFactory) {
      throw new RegistryFetchError("provider_error");
    }

    // PR-1: 注入境界までは確立できるが、実ログイン/検索/DL（実操作）は PR-2 で実装する。
    // 本番では getRegistryFetchProvider() が browserFactory を渡さない限りここへ来ても
    // 上の分岐で停止し、実取得は走らない。実装未完を provider_error として安全に表す。
    //
    // 下記参照は未使用警告回避のための明示的 no-op（PR-2 で実コードへ置換）。
    void request;
    void this.loginId;
    void this.password;
    void this.baseUrl;
    void this.timeoutMs;
    void this.now;
    void this.requestIdFactory;

    throw new RegistryFetchError("provider_error");
  }
}
