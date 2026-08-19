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
 *   例外は実況パネル (live-view-store.ts) 用のステップスクショのみ: 実行者本人限定の
 *   メモリ内 TTL ストアへ短時間保持する (DB/ディスク/localStorage への永続は引き続き禁止)。
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
  RegistrySearchRequest,
  RegistryCandidate,
  RegistryCertificateType,
  RegistryLiveReporter,
} from "./types";
import { CANCEL_ACCEPTED_MESSAGE } from "./cancel-safety";
import { RegistryFetchError } from "./errors";
import { runExclusivePurchase } from "./purchase-safety";
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
  /**
   * 所在/地番/家屋番号で候補検索する（PR-2b seam・任意実装）。
   * 実 Playwright 実装（セレクタ・本番接続）は本 PR では提供しない（optional のまま）。
   * 実装されていない adapter では provider 側が provider_error に分類する。
   */
  searchByLocation?(input: {
    address: string;
    lotNumber?: string | null;
    buildingNumber?: string | null;
    /** 実況パネル通知先 (任意・best-effort)。adapter がステップ+スクショを報告。 */
    live?: RegistryLiveReporter;
  }): Promise<RegistryCandidate[]>;
  /**
   * 段階②(2026-07-31): 所在検索で選ばれた候補(地番/家屋番号)の謄本を
   * **有料の請求→PDFダウンロード**まで通して取得する（任意実装）。
   * ⚠課金を伴う。**請求ボタンを押した後**の失敗は RegistryFetchError("charged_but_failed")
   * で返すこと（呼び出し側が再試行禁止・台帳記録に使う）。
   */
  /**
   * 【回収】既に**課金済み**の謄本PDFを、再課金なしで取り込む(2026-08-19・任意実装)。
   * ⚠**課金しない**: 請求・確定・確認ダイアログのＯＫには一切触れない実装であること。
   * マイページの「請求済 × 対象の所在/地番 × 期限内」の行を受付番号で選び、
   * 表示・保存(無料)で PDF を得る。見つからなければ RegistryFetchError("not_found")。
   */
  recoverRegistryPdfByLocation?(input: {
    address: string;
    lotNumber?: string | null;
    buildingNumber?: string | null;
    certificateType: RegistryCertificateType;
    baseUrl?: string;
    live?: RegistryLiveReporter;
  }): Promise<Buffer>;
  fetchByLocationCandidate?(input: {
    address: string;
    lotNumber?: string | null;
    buildingNumber?: string | null;
    certificateType: RegistryCertificateType;
    /**
     * 外側予算(withPaidTimeout)の**開始時刻基準**の締切(epoch ms・@codex #386 R2)。
     * 0件リトライの残量計算に使う。adapter 側で測り直すとログインが食った時間ぶん
     * 残量を過大評価するため、provider が確定して渡す。
     */
    paidDeadlineAt?: number | null;
    /**
     * 課金境界の共有フラグ(@codex #345 P1)。adapter は**請求ボタンを押す直前**に
     * `charged = true` を立てる。provider は外側 timeout 等で adapter の catch を
     * 経由せず失敗した場合でも、これを見て charged_but_failed に分類できる。
     *
     * ⚠aborted(@codex R10 P1): provider が**課金前タイムアウト**で reject した印。
     * reject しても実行中の op はキャンセルされない(JS の Promise は中断不能)ため、
     * 裏で走り続けた adapter が後から請求してしまうと**記録なき課金**になる。
     * adapter は**請求ボタンを押す直前に必ずこの印を確認**し、立っていれば課金せず
     * 中止する(charged への代入と同一同期区間で確認する=競合の隙間なし)。
     */
    chargeState?: { charged: boolean; aborted?: boolean };
    /**
     * 実況パネル(2026-08-15)。検索と同じ contract(固定文言のみ・非throw)。
     * ⚠有料フローは中止を受け付けないので isCancelRequested は配線されない。
     */
    live?: RegistryLiveReporter;
  }): Promise<Buffer>;
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
  /** 所在検索の実装/セレクタが校正済みか(専用フラグ)。true のときだけ supportsLocationSearch。 */
  supportsLocationSearch?: boolean;
  /**
   * 課金後の延長予算(ms)。既定 PAID_FLOW_EXTRA_TIMEOUT_MS。テスト注入用。
   * 課金後の有界ループ(最悪≈500秒)を打ち切らないための値で、短くしすぎると
   * 支払済みPDFを取り切れず charged_but_failed に固定される。
   */
  paidFlowExtraTimeoutMs?: number;
}

/**
 * 課金後の延長予算の既定値(10分)。adapter の課金後ループの最悪値から導出:
 * attempt 20回 × (sleep3s + 先頭復帰≤8s + ページ探索≤12s) ≈ 460s + DL待ち ≈ 500s。
 */
export const PAID_FLOW_EXTRA_TIMEOUT_MS = 10 * 60 * 1000;

/** 未分類の例外を provider_error に潰す（生メッセージ＝secret/PII を例外に載せない）。 */
/**
 * 順番待ちの間の中止を見に行く間隔 (@codex #357 P2)。
 * 待ち行列は有料取得が前に居ると数分になり得るため、押した人を待たせない。
 * 同一プロセス内のフラグを見るだけなので負荷は無視できる。
 */
const QUEUE_CANCEL_POLL_MS = 250;

/**
 * 有料取得が購入ミューテックスの順番待ちに費やせる上限(@codex #380 R4/R6 P2)。
 * ⚠心拍だけを止める(R4の初版)と、上限後も待ち続ける取得の実況が期限切れで消え、
 * 開始後の全 step が no-op になる(R6)。**待ちそのものに同じ寿命を与え**、超えたら
 * 「外部に一切触れる前に」rate_limited で失敗させる(=課金ゼロ・実況も正直)。
 * 30分は対話操作の待ちとしては十分すぎる上限(正常系では届かない)。
 */
const QUEUE_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

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
  /** 所在検索が使えるか(専用校正フラグ由来)。isRegistryLocationSearchConfigured が参照。 */
  readonly supportsLocationSearch: boolean;
  /** 課金後の延長予算(ms)。withPaidTimeout が参照。 */
  private readonly paidFlowExtraTimeoutMs: number;

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
    this.supportsLocationSearch = options.supportsLocationSearch === true;
    this.paidFlowExtraTimeoutMs =
      options.paidFlowExtraTimeoutMs ?? PAID_FLOW_EXTRA_TIMEOUT_MS;
  }

  async fetchRegistryPdf(
    request: RegistryFetchRequest,
  ): Promise<RegistryFetchResult> {
    // 段階②(2026-07-31): 所在検索の候補(地番/家屋番号)での有料取得。番号があれば番号を優先。
    const location = request.location ?? null;
    const realEstateNumber = request.realEstateNumber?.trim();
    if (!realEstateNumber && location) {
      return this.fetchByLocation(location, request.live);
    }
    // PR-2: 不動産番号がある物件に限定。空なら検索キーが無く取得不能（非PII前提を維持）。
    if (!realEstateNumber) {
      throw new RegistryFetchError("not_found");
    }

    // 2. レート制御（公式へアクセスする前に判定 = 過剰アクセスを物理的に防ぐ）。
    // @codex P2: fetch は search と別キー。検索→取得の対は両立させつつ、fetch 連打は 1件/分に保つ。
    if (this.throttle && !this.throttle.tryAcquire(`${this.name}:fetch`, this.now().getTime())) {
      throw new RegistryFetchError("rate_limited");
    }

    // 3. browserFactory 未注入 = 実ブラウザを起動する術がない = 未設定扱い（fail-closed）。
    if (!this.browserFactory) {
      throw new RegistryFetchError("provider_error");
    }

    const requestId = this.requestIdFactory();

    // 4. ブラウザ起動（動的 Playwright import / chromium.launch / newContext / newPage）。
    //    CodexP2: timeoutMs は login/search/download だけでなく **起動全体** にも効かせる。
    //    起動が解決しない（chromium 起動ハング等）と、後続の withTimeout に到達しないまま
    //    await が宙吊りになり、runRegistryAutoFetch が scheduled のまま catch/解除へ到達できず
    //    物件がロック固着する。よって factory 呼び出しを timeout budget 配下で実行する。
    //    起動段の失敗（依存未導入・起動不能・生エラー＝パス/内部情報が混入しうる）は、
    //    後続 try/catch（classifyRegistryFetchError）に入る前に発生するため、ここで明示的に
    //    provider_error へ正規化して生メッセージの伝播を防ぐ（RegistryFetchError は分類コード
    //    を保ったまま伝播）。timeout で打ち切った後に factory が遅れて page を返した場合は、
    //    宙に浮いたブラウザ/コンテキストをリークさせないよう、その page を best-effort で閉じる。
    // ⚠アカウント同時1セッション制約(@codex #345 P1): 番号取得のログインも購入と同じ
    // ミューテックスに通す。別経路のログインが並行すると、**進行中の購入セッションを
    // 強制ログアウトさせ、課金だけ済んでPDFを取り逃す**。search/fetch の throttle キーが
    // 別なのはレート制御の話で、セッションの排他はここで一元化する。
    return runExclusivePurchase(async () => {
      let page: RegistryBrowserPage;
      try {
        page = await this.withStartupTimeout(() => this.browserFactory!());
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
    });
  }

  /**
   * 【回収】既に購入済みの謄本PDFを、**再課金なしで**取り込む(2026-08-19)。
   *
   * 背景: 請求(課金)は成立したのに行の同定に失敗してPDFを取り逃すと、二重課金
   * ガードが働いて取り直せない=**払ったのに手元に残らない**。期限内ならサイトに
   * 残っているので、マイページから**表示・保存だけ**して回収する。
   *
   * ⚠構造は fetchByLocation と同じ(throttle → 直列化 → 起動timeout → login →
   * 実行 → 必ず close)。**直列化(runExclusivePurchase)は省略できない**: 登記
   * サービスは1IDにつき同時1セッションで、回収のログインが進行中の購入を強制
   * ログアウトさせると、**まさにこの機能が直そうとしている事故**(課金だけ済んで
   * PDFを取り逃す)を自分で起こす。
   *
   * ⚠課金しないので chargeState は持たず、charged_but_failed へも**倒さない**
   * (お金が動いていないのに『動いたかも』と伝える方が有害)。
   */
  async recoverRegistryPdf(
    request: RegistryFetchRequest,
  ): Promise<RegistryFetchResult> {
    // 回収は所在(地番/家屋番号)でしか引けない。番号経路(=課金フロー)は使わない。
    const location = request.location ?? null;
    if (!location) {
      throw new RegistryFetchError("provider_error");
    }
    if (
      this.throttle &&
      !this.throttle.tryAcquire(`${this.name}:fetch`, this.now().getTime())
    ) {
      throw new RegistryFetchError("rate_limited");
    }
    if (!this.browserFactory) {
      throw new RegistryFetchError("provider_error");
    }
    const requestId = this.requestIdFactory();
    const live = request.live;
    // 順番待ちの実況(有料取得と同じ理由: 3分の保管期限で診断が消えないように)。
    const queueHeartbeat = live
      ? setInterval(() => {
          try {
            live.step("他の取得の完了を待っています(課金はしません)");
          } catch {
            /* 実況の失敗で待ちを壊さない */
          }
        }, 60_000)
      : null;
    let acquired = false;
    let gaveUp = false;

    const run = runExclusivePurchase(async () => {
      if (gaveUp) {
        // 呼び出し元は rate_limited で決着済み。外部に触れずに終わる。
        throw new RegistryFetchError("rate_limited");
      }
      acquired = true;
      if (queueHeartbeat) clearInterval(queueHeartbeat);
      let page: RegistryBrowserPage;
      try {
        page = await this.withStartupTimeout(() => this.browserFactory!());
      } catch (err) {
        throw classifyRegistryFetchError(err);
      }
      try {
        // adapter 未対応(fake page 等)は login(実外部接続)の**前に** fail-fast。
        const recover = page.recoverRegistryPdfByLocation;
        if (!recover) {
          throw new RegistryFetchError("provider_error");
        }
        const pdfBuffer = await this.withRecoverTimeout(async () => {
          await page.login({
            loginId: this.loginId,
            password: this.password,
            baseUrl: this.baseUrl,
          });
          return recover.call(page, {
            ...location,
            certificateType: location.certificateType,
            baseUrl: this.baseUrl,
            live,
          });
        });
        return {
          pdfBuffer,
          // 非PII の generic filename(地番・所有者名を埋め込まない)。
          fileName: `registry-recovered-${requestId}.pdf`,
          source: this.name,
          fetchedAt: this.now(),
          providerRequestId: requestId,
        };
      } catch (err) {
        // ⚠課金していないので charged_but_failed には**倒さない**(分類を汚さない)。
        throw classifyRegistryFetchError(err);
      } finally {
        try {
          await page.close();
        } catch {
          // close 失敗は握りつぶす。
        }
      }
    });

    const guarded = new Promise<RegistryFetchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!acquired) {
          gaveUp = true;
          try {
            live?.step(
              "⚠混み合っているため取り込みを開始できませんでした(課金はしていません)。時間をおいて再実行してください",
            );
          } catch {
            /* 実況は best-effort */
          }
          reject(new RegistryFetchError("rate_limited"));
        }
      }, QUEUE_WAIT_TIMEOUT_MS);
      run.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    return guarded.finally(() => {
      if (queueHeartbeat) clearInterval(queueHeartbeat);
    });
  }

  /**
   * 段階②(2026-07-31): 所在検索の候補(地番/家屋番号)での**有料取得**。
   * 構造は fetchRegistryPdf と同じ（throttle → browserFactory → 起動timeout → login →
   * 実行 → 必ず close）だが、**全体を runExclusivePurchase で直列化**する。
   *
   * ⚠直列化はお金の安全機構（purchase-safety.ts §「3つの防御」）:
   * 登記サービスは**1IDにつき同時1セッション**で、別物件の購入が並行すると後発が先発を
   * 強制ログアウトさせ、**先発は課金だけ済んでPDFを取り逃す**。DB の物件ロックは物件が
   * 違うと効かないため、プロセス内でここを1件ずつにする（本番は単一プロセス運用・実測済）。
   *
   * ⚠課金後の失敗（adapter が charged_but_failed を投げた場合）は**分類を変えずに**上げる。
   * classifyRegistryFetchError は RegistryFetchError をそのまま通すので保持される。
   */
  private async fetchByLocation(
    location: NonNullable<RegistryFetchRequest["location"]>,
    // 実況(2026-08-15・任意)。呼び出し元 fetchRegistryPdf から request.live を受け取る。
    live?: RegistryLiveReporter,
  ): Promise<RegistryFetchResult> {
    // レート制御は番号取得と同じ fetch キー（公式アクセス前に判定）。
    if (
      this.throttle &&
      !this.throttle.tryAcquire(`${this.name}:fetch`, this.now().getTime())
    ) {
      throw new RegistryFetchError("rate_limited");
    }
    if (!this.browserFactory) {
      throw new RegistryFetchError("provider_error");
    }
    const requestId = this.requestIdFactory();

    // ⚠順番待ちの間も実況を生かす(@codex #380 R2 P2)。購入ミューテックスは一括取得と
    //   共有なので、先客(一括の数件分)で3分を超えると、この取得の実況は初手1行のまま
    //   保管期限(LIVE_VIEW_TTL_MS=3分)で**消え**、以降の step は -1 の no-op になる
    //   (=一番の目的だった診断が丸ごと失われる)。取得開始まで60秒ごとに固定文言を
    //   刻んで期限を更新する。step は同期・非throw契約なので interval から安全に呼べる。
    const queueHeartbeat = live
      ? setInterval(() => {
          try {
            live.step("他の取得の完了を待っています(まだ課金されていません)");
          } catch {
            /* 実況の失敗で待ちを壊さない */
          }
        }, 60_000)
      : null;
    // ⚠待ちそのものに寿命を与える(@codex #380 R4/R6 P2)。上限を超えたら
    //   gaveUp を立てて rate_limited で即座に失敗し、**あとから順番が回ってきた
    //   コールバックは冒頭で何もせず抜ける**(page 生成もログインもしない=外部無接触・
    //   課金ゼロ)。gaveUp の判定と acquired の代入はどちらも同期区間なので競合しない。
    let acquired = false;
    let gaveUp = false;

    const run = runExclusivePurchase(async () => {
      if (gaveUp) {
        // 呼び出し元はすでに rate_limited で決着済み。ここで外部に触れると
        // 「記録なき課金」への入口になるため、何もせずに終わる。
        throw new RegistryFetchError("rate_limited");
      }
      acquired = true;
      if (queueHeartbeat) clearInterval(queueHeartbeat);
      let page: RegistryBrowserPage;
      try {
        page = await this.withStartupTimeout(() => this.browserFactory!());
      } catch (err) {
        throw classifyRegistryFetchError(err);
      }
      // ⚠課金境界の追跡(@codex #345 P1): 外側の withTimeout(REGISTRY_FETCH_TIMEOUT_MS)は
      // **請求ボタンを押した後**に発火し得る(adapter は請求済への反映を最大60秒待つ)。
      // その timeout を素の "timeout" で返すと、呼び出し側は台帳に書かず再実行できて
      // しまう=二重課金。adapter が請求を押す直前に立てるこのフラグを catch で見て、
      // 課金後なら分類を charged_but_failed に固定する。
      const chargeState = { charged: false, aborted: false };
      try {
        // adapter 未対応（fake page 等）は login(実外部接続)の**前に** fail-fast
        // （searchCandidates と同じ方針・無駄な実ログインをしない・課金前）。
        const fetchByLocationCandidate = page.fetchByLocationCandidate;
        if (!fetchByLocationCandidate) {
          throw new RegistryFetchError("provider_error");
        }
        // ⚠有料フローは二段タイムアウト(@codex R8 P1): 課金前=通常予算 /
        // 課金後=延長予算(支払済みPDFを取り切るため)。
        // ⚠0件リトライの予算計算は**外側タイマーの開始時刻**を基準にする(@codex #386 R2)。
        // adapter 側入口(=ログイン後)で測ると、ログインが食った時間ぶん残量を過大評価し、
        // リトライが外側 timeout を再び踏む。ここで deadline を確定して渡す。
        const paidDeadlineAt =
          this.timeoutMs && Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
            ? Date.now() + this.timeoutMs
            : null;
        const pdfBuffer = await this.withPaidTimeout(async () => {
          await page.login({
            loginId: this.loginId,
            password: this.password,
            baseUrl: this.baseUrl,
          });
          // 実況(あれば)を adapter へ渡す(2026-08-15)。login は provider 側なので、
          // ここまでの進行は route の受付ステップが埋める。
          return fetchByLocationCandidate.call(page, {
            ...location,
            chargeState,
            live,
            paidDeadlineAt,
          });
        }, chargeState);
        return {
          pdfBuffer,
          // 非PII の generic filename（地番・所有者名を埋め込まない）。
          fileName: `registry-auto-${requestId}.pdf`,
          source: this.name,
          fetchedAt: this.now(),
          providerRequestId: requestId,
        };
      } catch (err) {
        if (chargeState.charged) {
          // 請求済み(の可能性)。timeout も含め charged_but_failed に固定する。
          if (
            err instanceof RegistryFetchError &&
            err.code === "charged_but_failed"
          ) {
            throw err;
          }
          throw new RegistryFetchError("charged_but_failed");
        }
        throw classifyRegistryFetchError(err);
      } finally {
        try {
          await page.close();
        } catch {
          // close 失敗は握りつぶす（元のエラー / 成功結果を優先）。
        }
      }
    });

    // 待ちの寿命。acquired 前に満了したら gaveUp を立てて即座に失敗させる。
    // run 側の遅延 throw(rate_limited) は既に決着済みの guarded に届かないため
    // catch で握る(未処理拒否の警告を出さない)。
    const guarded = new Promise<RegistryFetchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!acquired) {
          gaveUp = true;
          try {
            live?.step(
              "⚠混み合っているため取得を開始できませんでした(課金されていません)。時間をおいて再実行してください",
            );
          } catch {
            /* 実況は best-effort */
          }
          reject(new RegistryFetchError("rate_limited"));
        }
      }, QUEUE_WAIT_TIMEOUT_MS);
      run.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    return guarded.finally(() => {
      // ⚠取得開始時にも clear しているが、**待ちのまま満了した経路**では
      // コールバックが走らない。二重 clear は無害。
      if (queueHeartbeat) clearInterval(queueHeartbeat);
    });
  }

  /**
   * 所在検索（PR-2b seam）。fetchRegistryPdf と同じ安全構造（throttle → browserFactory →
   * 起動 timeout → login → 検索 → 必ず close）を踏襲する。
   *
   * 実 Playwright 所在検索（page.searchByLocation の実体・セレクタ）は実装済み(2026-07-14 実画面HTMLで
   * 校正)。ただし **本番は既定で休眠**: provider は REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED="true"
   * （+ SELECTORS_CALIBRATED）が無い限り解決されず（getRegistryFetchProvider()==null → route 501）、
   * 実サイトへ一切アクセスしない。動的部分の最終確定は live 校正(約款確認後)で行う。
   * 候補（秘匿情報）は呼び出し側が log/Audit/error response に出さない。
   */
  async searchCandidates(
    request: RegistrySearchRequest,
  ): Promise<RegistryCandidate[]> {
    // @codex P2: search は fetch と別キー。検索→取得の対は両立させつつ、検索連打は 1件/分に保つ。
    if (
      this.throttle &&
      !this.throttle.tryAcquire(`${this.name}:search`, this.now().getTime())
    ) {
      throw new RegistryFetchError("rate_limited");
    }
    if (!this.browserFactory) {
      throw new RegistryFetchError("provider_error");
    }

    // ⚠アカウント同時1セッション制約(@codex #345 P1): **検索のログインも購入と同じ
    // ミューテックス**に通す。検索が購入と並行してログインすると、進行中の購入
    // セッションを強制ログアウトさせ、**課金だけ済んでPDFを取り逃す**。
    // ⚠**待ち行列に残る処理を確実に止めるための局所の印** (@codex #357 P2)。
    // 早めに中止として返すと、route は後片付けで**共有の印を消す**。順番が
    // 回ってきた処理が共有の印だけを見ていると「中止されていない」と判断し、
    // **中止したはずの検索がブラウザを起動してログインしてしまう**。
    // 共有の印の寿命に依存しないよう、この実行専用の印も併せて見る。
    let cancelObserved = false;
    const isCancelled = (): boolean =>
      cancelObserved || request.live?.isCancelRequested?.() === true;
    const started = runExclusivePurchase(async () => {
      // ⚠**順番待ちの間に押された中止を、ここで拾う** (@codex #357 P2)。
      // アカウント同時1セッション制約のため、検索は上のミューテックスで
      // 待たされることがある。待っている間の中止に気づかないと、
      //   (1) 中止したのに**登記情報提供サービスへログインしてしまう**
      //   (2) 起動やログインが失敗すると「中止」ではなく**外部サービスの障害**
      //       として利用者にも監査にも残る
      // の2つが起きる。ブラウザを起動する前が最初の安全な節目。
      // 候補検索(段階①)はお金が動かないので、いつ止めても安全。
      const abortIfCancelled = (): void => {
        if (!isCancelled()) return;
        try {
          request.live?.step(CANCEL_ACCEPTED_MESSAGE);
        } catch {
          /* 実況は best-effort */
        }
        throw new RegistryFetchError("cancelled");
      };
      // ⚠**待っている最中に押された中止を、失敗に化けさせない** (@codex #357 P2)。
      // ブラウザの起動やログインには時間がかかる。その待ちの最中に中止が押されて
      // 待ちが失敗(timeout 等)で終わると、そのまま分類すると
      // **利用者が自分で止めたのに「外部サービスの障害」として残る**
      // (実況にも監査にも失敗として出る)。中止が押されていれば中止を優先する。
      // 候補検索(段階①)は課金が動かないので、この扱いで取り違えは起きない。
      const classifyOrCancelled = (err: unknown): RegistryFetchError => {
        if (isCancelled()) {
          try {
            request.live?.step(CANCEL_ACCEPTED_MESSAGE);
          } catch {
            /* 実況は best-effort */
          }
          return new RegistryFetchError("cancelled");
        }
        return classifyRegistryFetchError(err);
      };
      abortIfCancelled();
      // 実況パネル (#317 とは別機能): ステップ進行の通知。label は固定文言のみ
      // (所在・地番・資格情報を入れない)。reporter は非 throw 契約だが、実況が
      // 検索本体を壊さないよう optional chain のみで触る。
      request.live?.step("自動操作ブラウザを起動しています…");
      let page: RegistryBrowserPage;
      try {
        page = await this.withStartupTimeout(() => this.browserFactory!());
      } catch (err) {
        throw classifyOrCancelled(err);
      }

      try {
        // searchByLocation は optional(seam)。未提供の adapter では login(実外部接続)の前に
        // fail-fast し無駄な実ログインを避ける → provider_error。実 adapter は実装済みだが、
        // 本番は provider 未解決(休眠フラグ)=501 ゆえ、この経路は fake page 注入テストで到達する。
        const searchByLocation = page.searchByLocation;
        if (!searchByLocation) {
          throw new RegistryFetchError("provider_error");
        }
        return await this.withTimeout(async () => {
          // ⚠ログインの直前でもう一度見る (@codex #357 P2)。ブラウザの起動には
          // 時間がかかるので、その間に押された中止をここで拾う
          // = **無駄な実ログインをしない**。
          abortIfCancelled();
          // ログイン場面は撮影しない (ID/PW が画面に写り得るため文言のみ =
          // ユーザー合意済みの「ぼかし or 省略」の省略側)。
          request.live?.step(
            "登記情報提供サービスへログインしています…(この画面の表示は省略されます)",
          );
          await page.login({
            loginId: this.loginId,
            password: this.password,
            baseUrl: this.baseUrl,
          });
          return searchByLocation.call(page, {
            address: request.address,
            lotNumber: request.lotNumber,
            buildingNumber: request.buildingNumber,
            live: request.live,
          });
        });
      } catch (err) {
        // ログインの待ちが中止と同時に失敗した場合も、中止として返す。
        throw classifyOrCancelled(err);
      } finally {
        try {
          await page.close();
        } catch {
          // close 失敗は握りつぶす（元のエラー / 成功結果を優先）。
        }
      }
    });

    // ⚠**順番待ちの間に押された中止で、すぐ画面を解放する** (@codex #357 P2)。
    //
    // 検索は有料取得と同じ順番待ちに並ぶ。前が有料取得だと、順番が回るまで
    // 数分かかることがある。上の中止確認は**自分の順番が来て初めて**動くため、
    // 待っている間に中止を押した人は、実際には何も始まっていないのに
    // 「中止しています…」の表示のまま数分待たされる。
    //
    // 待ち行列を抜けるのを待たずに中止として返す。実際の処理は、順番が回った
    // ときに先頭の確認で自分から止まるので、放置しても外部サイトには触らない。
    // 候補検索(段階①)はお金が動かないので、これで取り違えは起きない。
    if (!request.live?.isCancelRequested) return started;
    return await new Promise<RegistryCandidate[]>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        fn();
      };
      const timer = setInterval(() => {
        if (request.live?.isCancelRequested?.() !== true) return;
        finish(() => {
          // ⚠共有の印は route の後片付けで消えるので、**この実行専用の印**を
          // 立ててから返す。順番が回ってきた処理はこれを見て自分から止まる。
          cancelObserved = true;
          // 順番待ちのまま残る処理の失敗を拾っておく (握り潰さないと
          // 未処理の rejection になる)。処理自体は順番が来たら自分で止まる。
          void started.catch(() => {});
          try {
            request.live?.step(CANCEL_ACCEPTED_MESSAGE);
          } catch {
            /* 実況は best-effort */
          }
          reject(new RegistryFetchError("cancelled"));
        });
      }, QUEUE_CANCEL_POLL_MS);
      // このタイマーでプロセスの終了を妨げない。
      (timer as { unref?: () => void }).unref?.();
      started.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  /**
   * timeoutMs 指定時、op をタイムアウト付きで実行する。期限超過は RegistryFetchError("timeout")。
   * 未指定なら op をそのまま await（タイムアウト無し）。
   */
  /**
   * 有料フロー用の二段タイムアウト(@codex #345 R8 P1)。
   *
   * 通常の withTimeout(REGISTRY_FETCH_TIMEOUT_MS・例30秒)は、課金後の
   * 「請求済+PDF準備完了」待ち(最大60秒+ページ探索)より**短くなり得る**。
   * その場合、支払いは済んでいるのに打ち切られ、台帳に charged_but_failed で
   * 固定される(実際は数十秒後に取れるのに)。
   *
   * そこで予算を課金境界で分ける:
   *  - **課金前**(chargeState.charged=false): 従来どおり timeoutMs で打ち切り(timeout)。
   *    まだ無料なので早く諦めてよい。
   *  - **課金後**: 打ち切らず paidFlowExtraTimeoutMs まで延長。adapter の課金後
   *    ループは attempt/ページ数/各待ちがすべて有界(最悪 ≈500秒)なので、この
   *    延長は暴走ではなく「支払済みPDFを取り切るための予算」。それでも尽きたら
   *    charged_but_failed(台帳記録は呼び出し側で行われる)。
   */
  /**
   * 回収(課金なし)の予算。ログイン〜マイページ走査〜PDF保存まで通すため、
   * 課金後と同じ延長予算を使う(短い通常予算だとPDF保存の途中で切れる)。
   */
  private async withRecoverTimeout<T>(op: () => Promise<T>): Promise<T> {
    const timeoutMs = this.timeoutMs;
    if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return op();
    }
    const budget = timeoutMs + (this.paidFlowExtraTimeoutMs ?? 0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        op(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new RegistryFetchError("timeout"));
          }, budget);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private withPaidTimeout<T>(
    op: () => Promise<T>,
    chargeState: { charged: boolean; aborted?: boolean },
  ): Promise<T> {
    const timeoutMs = this.timeoutMs;
    if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return op();
    }
    const extraMs = this.paidFlowExtraTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      const softTimer = setTimeout(() => {
        if (!chargeState.charged) {
          // 課金前=無料。従来どおりの打ち切り。
          // ⚠reject しても op はキャンセルされない(@codex R10 P1)。裏で走り続けた
          // adapter が後から請求すると**記録なき課金**になるため、中止の印を先に
          // 立てる(adapter は請求ボタンの直前で必ずこれを確認する)。
          chargeState.aborted = true;
          reject(new RegistryFetchError("timeout"));
          return;
        }
        // 課金後=支払済み。準備待ちに十分な予算まで延長する。
        hardTimer = setTimeout(() => {
          reject(new RegistryFetchError("charged_but_failed"));
        }, extraMs);
      }, timeoutMs);
      const clear = () => {
        clearTimeout(softTimer);
        if (hardTimer) clearTimeout(hardTimer);
      };
      op().then(
        (value) => {
          clear();
          resolve(value);
        },
        (err) => {
          clear();
          reject(err);
        },
      );
    });
  }

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

  /**
   * ブラウザ起動（browserFactory）専用の timeout ラッパ（CodexP2）。
   *
   * withTimeout との違い: ここで race するのは page をまだ握っていない起動段のため、timeout で
   * 打ち切った後に factory が **遅れて** RegistryBrowserPage を resolve するケースがある。その
   * page は fetchRegistryPdf の finally に到達しない（既に timeout を throw 済み）ので、宙に浮いた
   * ブラウザ/コンテキスト/Chromium プロセスがリークする。これを防ぐため、timeout 後に到着した
   * page は本ラッパ内で best-effort で close する（生エラーは握りつぶし元の timeout を優先）。
   * timeoutMs 未指定なら factory をそのまま await（タイムアウト無し）。
   */
  private withStartupTimeout(
    factory: () => Promise<RegistryBrowserPage>,
  ): Promise<RegistryBrowserPage> {
    const timeoutMs = this.timeoutMs;
    if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return factory();
    }
    return new Promise<RegistryBrowserPage>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new RegistryFetchError("timeout"));
      }, timeoutMs);
      factory().then(
        (page) => {
          clearTimeout(timer);
          if (settled) {
            // timeout 後に遅れて起動完了 → 宙に浮いた page を確実に閉じる（リーク防止）。
            void page.close().catch(() => {
              // close 失敗は握りつぶす（既に timeout を呼び出し側へ返している）。
            });
            return;
          }
          resolve(page);
        },
        (err) => {
          clearTimeout(timer);
          if (settled) return; // 既に timeout で reject 済み。
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
