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
import type { ResolvedRegistryCredentials } from "@/lib/registry-fetch/config-store";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  ZERO_RETRY_SLEEP_MS,
  resolveCleanupBound,
  resolveRetryWaitAfterSetup,
  resolveSecondZeroProbe,
  resolveZeroRetryPlan,
} from "@/lib/registry-fetch/zero-retry-plan";
import {
  KNOWN_PROBE_SELECTORS,
  formatRegistryPageProbe,
  type RegistryPageProbe,
} from "@/lib/registry-fetch/page-probe";
import {
  effectiveLocationIdentifier,
  isReadableChiban,
  normalizeChibanForDialog,
} from "@/lib/registry-fetch/chiban-input";
import {
  dialogAmountMatches,
  pickConfirmButtonIndex,
  resolveSeikyuConfirm,
} from "@/lib/registry-fetch/seikyu-confirm";
import {
  collectBaselineReceiptNos,
  parseMyPageRowCells,
  FUDOSAN_LIST_HIDDEN_PREFIX,
  pickChargedMyPageRow,
  stripTrailingIdentifierFromKuiki,
  normalizeKuikiForCompare,
  selectFudosanListRow,
  type FudosanListRow,
  type MyPageScanRow,
} from "@/lib/registry-fetch/fudosan-list-select";

// 既存の import 元(テスト等)向けに再エクスポート(実体は各純関数モジュールへ移動)。
export { normalizeChibanForDialog } from "@/lib/registry-fetch/chiban-input";
export { registryRowMatchesChiban } from "@/lib/registry-fetch/fudosan-list-select";
import {
  CANCEL_ACCEPTED_MESSAGE,
  CANCEL_IGNORED_CHARGED_MESSAGE,
  decideCancel,
} from "@/lib/registry-fetch/cancel-safety";
import {
  SHOZAI_DIALOG_BUTTON_SCOPE,
  dedupeShozaiDialogItems,
  looksLikeLotTail,
  matchDialogItemByPrefix,
  normalizeForMatch,
  type ShozaiDialogItem,
} from "@/lib/registry-fetch/shozai-dialog";
import { processRegistryPdf, type RegistryPdfSession } from "@/lib/registry-pdf/process";
import {
  buildApprovedDuplicateGuard,
  type ApprovedPreflightFlags,
} from "@/lib/registry-fetch/duplicate-guard";
import {
  RegistryFetchError,
  DEFAULT_CERTIFICATE_TYPE,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
  type RegistryCertificateType,
  type RegistryLiveReporter,
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
import { fingerprintProperty } from "./candidate-cache";
import { canDownloadRow, purchaseIdempotencyKey } from "./purchase-safety";
import { createHash } from "crypto";

export interface RunRegistryAutoFetchArgs {
  /** 認証済みセッション（route の getApiSession から id/role のみ）。 */
  session: RegistryPdfSession;
  /** 取得対象物件ID（route path の {id}）。 */
  propertyId: string;
  /** 課金を伴う操作のため明示確認フラグ。true 以外は実行しない。 */
  confirmed: boolean;
  /**
   * 実行モード(2026-08-19)。
   * - "purchase"(既定): 従来の有料取得(請求→課金→PDF)。
   * - "recover": **既に課金済み**の書類をマイページから取り込むだけ(課金しない)。
   *   第8回テストのように「請求は成立したがPDFを取り逃した」場合の救済。
   *   ⚠課金しないので、有料取得のスイッチ(REGISTRY_FETCH_PURCHASE_ENABLED)も
   *   二重課金ガード(台帳照合)も通さない(むしろ台帳に記録がある状態で使う)。
   */
  mode?: "purchase" | "recover";
  /**
   * 【回収・候補なし】どちらの登記を取り込むか(@codex #394 R13 P1)。
   * 物件が地番と家屋番号の**両方**を持つ場合、既定の選び方(家屋番号優先)だと
   * 土地の購入を永久に取り込めず、条件次第では**建物のPDFを土地の物件へ**
   * 取り込みかねない。利用者に選ばせた結果をここで受ける。
   */
  recoverKind?: "land" | "building";
  /**
   * 【回収・候補なし】画面が見せていた版番号(@codex #394 R20 P1)。
   * ⚠候補経由には指紋(expectedFingerprint)があるが、物件経由には無かった。
   *   確認の後に地番が編集されると**見たものと違う筆**を取り込み、所有者事項なら
   *   所有者の紐付けまで書き換わる。一致しなければ 409。
   */
  recoverExpectedVersion?: number;
  /**
   * 【回収・候補なし】画面が見せていた識別子(地番 or 家屋番号)。
   * ⚠**一致判定にのみ使う**(取得キーは常にDBの値)。表記ゆれは正規化して比べる。
   */
  recoverExpectedIdentifier?: string | null;
  /**
   * 【回収・候補なし】画面が見せていた所在(@codex #394 R23 P1)。
   * ⚠**版番号だけでは足りない**: CSV取込の重複更新は version を上げずに address を
   *   書き換える経路がある。所在が変わると探す区域が変わり、**別の物件の書類**を
   *   取り込みかねない。provider が使う値は全部この検査に含める。
   */
  recoverExpectedAddress?: string | null;
  /**
   * 取得キーの上書き（所在検索で server 側再解決した候補の不動産番号／cond③）。
   * 指定時はこれを fetchRegistryPdf に使う（物件は番号未保持のため）。未指定は物件の realEstateNumber。
   */
  realEstateNumber?: string | null;
  /**
   * @codex P2: override を使う所在検索取得での TOCTOU 防止。resolve が候補を確定した時点の物件指紋。
   * ここで version-lock する行の指紋がこれと一致しなければ 409（resolve〜取得の間の編集を弾く）。
   */
  expectedFingerprint?: string;
  /**
   * @codex #399 R5 P2: 画面が**課金を承認した時点**の事前警告の状態。
   * ⚠承認時に「無かった」項目だけを、**ロックと同じ一文**で検査する
   * （別の問い合わせでは、相手の未確定な処理を読み落として重複購入し得る）。
   * ⚠警告を見たうえで意図して買い直す運用は従来どおり許す（承認済み=true は条件にしない）。
   */
  approvedPreflight?: ApprovedPreflightFlags;
  /**
   * 段階②(2026-07-31): 所在検索で選ばれた候補(地番/家屋番号)での**有料取得**。
   * realEstateNumber と排他（両方指定は番号を優先）。値は秘匿情報＝log/監査/応答に出さない。
   */
  locationCandidate?: {
    lotNumber: string | null;
    buildingNumber: string | null;
  } | null;
  /**
   * 謄本の請求種別（所有者事項=owner / 全部事項=all）。未指定は既定=owner。
   * ⚠この値は**二重課金の鍵**にも provider への**請求**にも同じものが使われる。
   */
  certificateType?: RegistryCertificateType;
  /**
   * 実況パネル(2026-08-15・任意)。route が実行者本人限定のメモリ内ストアへ橋渡しする。
   * ⚠有料取得は中止を受け付けない=reporter に isCancelRequested は配線されない。
   */
  live?: RegistryLiveReporter;
}

/**
 * 有料取得の台帳 AuditLog action(段階②)。detail は purchaseKeyHash(鍵のsha256先頭32桁・
 * 非PII)と outcome のみ。**二重課金ガードの正**としてここを検索する。
 */
export const REGISTRY_PURCHASE_AUDIT_ACTION = "registry_location_purchase";

/** 台帳の照合窓。この期間内の同一鍵の購入は再実行させない(30日)。 */
const PURCHASE_LEDGER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// provider 失敗（RegistryFetchError）の分類コード → 安全な HTTP ステータス。
// 外部レスポンス本文・認証情報・PII は載せず、分類のみで応答する。
const PROVIDER_ERROR_STATUS: Readonly<Record<RegistryFetchErrorCode, number>> = {
  timeout: 504,
  rate_limited: 429,
  auth_failed: 502,
  // 業務的 not found（対象謄本が存在しない）。upstream 障害（502）と区別し 404 を返す。
  // 502 だとクライアント/呼び出し側が「一時的な upstream 障害 → リトライ」と誤認しうるため。
  not_found: 404,
  // 所在の指定が受け付けられない=**入力の問題**。upstream 障害(502)でも
  // 「存在しない」(404)でもないので 422(内容が処理できない)を返し、
  // 利用者に「住所を直せば通る」と伝わる分類にする。
  location_rejected: 422,
  // 利用者が自分で止めた=クライアント都合の中断。499 は非標準なので 409
  // (現在の状態と衝突)を使い、サーバー障害(5xx)と明確に分ける。
  cancelled: 409,
  provider_error: 502,
  service_hours: 503, // 利用時間外=一時的に利用不可(Service Unavailable)。
  service_unavailable: 503, // 接続不可(時間外の可能性)=同じく一時的利用不可。
  // ⚠課金後の失敗。502 だが「リトライ可能な upstream 障害」ではない(メッセージ側で
  // 再実行禁止とマイページ確認を案内)。
  charged_but_failed: 502,
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
  /**
   * DB（復号）優先・env フォールバックで解決した資格情報。呼び出し側（async route）が
   * loadRegistryFetchCredentials() で解決して注入する。未注入時は env を直接読む（後方互換）。
   */
  credentials?: Partial<ResolvedRegistryCredentials>;
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
  // options は Playwright の FillOptions 相当 (timeout を渡すため)。
  fill(selector: string, value: string, options?: unknown): Promise<void>;
  click(selector: string): Promise<void>;
  // 所在検索は多段UI(都道府県プルダウン・直接入力チェック)を伴う。実 Playwright Page の
  // selectOption/check に委譲する(fake page はテストで mock)。
  selectOption(selector: string, value: string): Promise<unknown>;
  check(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: unknown): Promise<unknown>;
  // ブラウザ内で関数を評価する（実 Playwright Page.evaluate）。ログインボタンのような
  // type="button"+onclick(JS submit)を、被り/actionability に左右されず DOM click で発火するために使う。
  // 戻り値は使わないため unknown（実 Playwright Page.evaluate はより広い型だが構造的に代入可能）。
  evaluate(pageFunction: (arg: string) => unknown, arg: string): Promise<unknown>;
  waitForEvent(event: string, options?: unknown): Promise<RegistryDownloadLike>;
  // ブラウザ内の述語が真になるまで待つ（実 Playwright Page.waitForFunction）。候補一覧の
  // 次ページ遷移で「ページが実際に切り替わった（=1行目の候補refが変わった）」ことを待つのに使う。
  waitForFunction(
    pageFunction: (arg: unknown) => unknown,
    arg?: unknown,
    options?: unknown,
  ): Promise<unknown>;
  // 所在検索の結果行を DOM から抽出する（実 Playwright は $$eval で各行のセルを読む）。
  $$eval(selector: string, pageFunction: (elements: Element[]) => unknown[]): Promise<unknown[]>;
  // 実況パネル用の viewport スクショ（実 Playwright Page.screenshot）。optional:
  // fake page が未実装でも動作は変わらない（実況は best-effort・文字進行のみになる）。
  // fullPage は使わない（viewport = ユーザー要望「画面全体をそのまま」の表示範囲）。
  screenshot?(options?: {
    type?: "jpeg" | "png";
    quality?: number;
    timeout?: number;
  }): Promise<Buffer | Uint8Array>;
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
export const DEFAULT_REGISTRY_BASE_URL = "https://www.touki.or.jp";

/**
 * ログインページの既定パス（base URL に前置する相対パス）。
 *
 * コンテキストルート /TeikyoUketsuke/ = ログイン画面の入口（2026-07-17 本番VPSの headless
 * chromium で実測・ログイン成功まで実証）。旧値 /TeikyoUketsuke/common/login（保存HTMLの
 * form action パス）は **直接アクセスするとセッション未確立で「ページ期限切れ」画面**
 * （フォーム無し・HTTP 200）が返り、#userId の fill timeout → auth_failed になる。
 * form の送信先パスと「ブラウザで開く入口」は別物。
 * REGISTRY_FETCH_LOGIN_PATH（env）で上書き可能(サイト改修時の即応用)。
 * 非PII・非secret（公開された公式サービスのパス）。
 */
export const DEFAULT_REGISTRY_LOGIN_PATH = "/TeikyoUketsuke/";
/**
 * マイページ(請求一覧)のパス [確定・2026-08-19 probe15/16]。
 * ⚠**回収(既に課金済みのPDFを取り込む)専用**の入口。ここから先で請求ボタンには
 * 一切触れない(課金しない)。
 */
export /**
 * 【回収】マイページ走査の上限ページ数(@codex #394 R4 P2)。
 *
 * ⚠回収の対象は**過去に買ったもの**なので、口座の履歴を遡る必要がある。
 * 上限が小さいと、まだ期限内の購入が奥のページにあっても『見つかりません』と
 * 言ってしまう(=嘘)。上限は大きく取り、それでも尽きたら**見つからないとは**
 * **言わず**に『最後まで確認できなかった』として返す。
 * 全体の予算(withRecoverTimeout)が別にあるので、走り続けることにはならない。
 */
const RECOVER_MAX_PAGES = 60;

const REGISTRY_MYPAGE_PATH = "/TeikyoUketsuke/mypage/my-page";

/**
 * 利用者のブラウザに開かせるログイン画面URL(A案・@codex #381 R1/R2 P2)。
 *
 * ⚠**自動操作用の REGISTRY_FETCH_BASE_URL / LOGIN_PATH は絶対に使わない**(R2)。
 *   それらは内部エンドポイントを指し得る値で、この模块自身が診断ログからも
 *   伏せている(baseUrl/loginUrl の redact)。応答に載せれば全認可クライアントへ
 *   構成が漏れ、ブラウザから届かないURLをリンクにもしてしまう。
 * ⚠かといってコンパイル時の既定値だけだと、公式サイトのURL変更に画面が
 *   追従できない(R1)。→**公開専用の env `REGISTRY_FETCH_PUBLIC_LOGIN_URL`** を新設し、
 *   https の絶対URLとして読めたときだけ採用・それ以外は公式既定値に固定する。
 *   任意設定(未設定で従来どおり)・非secret。
 */
export function publicRegistryLoginUrl(): string {
  const raw = process.env.REGISTRY_FETCH_PUBLIC_LOGIN_URL?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      // http は不可(資格情報を打つ画面へ平文で誘導しない)。読めない値も既定へ。
      // ⚠userinfo(https://user:pass@host/)も不可(@codex #381 R3 P2)。toString() は
      //   埋め込み資格情報を保持するため、通すと preflight 応答で全認可クライアントへ
      //   その資格情報を配ってしまう。
      if (u.protocol === "https:" && u.username === "" && u.password === "") {
        return u.toString();
      }
    } catch {
      /* 既定値へ */
    }
  }
  return `${DEFAULT_REGISTRY_BASE_URL}${DEFAULT_REGISTRY_LOGIN_PATH}`;
}

/**
 * 二重ログイン確認画面「ご利用中の方へ」(force-login-confirm)の判定マーカー。
 *
 * 登記情報提供サービスは1IDにつき同時1セッションのため、前回セッションが残っていると
 * ログイン送信後にこの画面が挟まる(2026-07-17 本番VPS実測で確認)。この画面固有の
 * hidden input(from=elogin)で判定する。loggedIn(logoutForm)はこの画面にも存在するため
 * 単独では通常メニューと区別できず、この画面を「ログイン成功」と誤認して後続の検索操作で
 * 失敗していた(=本番の実失敗)。テストが値を参照するため export する。非PII・非secret。
 */
export const REGISTRY_FORCE_LOGIN_MARKER = 'input[name="from"][value="elogin"]';

/**
 * 送信前のログインフォームに付ける印。
 *
 * ⚠「#userId が在る」だけでは**弾かれて戻ってきたフォーム**と
 * **まだ遷移していない元のフォーム**を区別できない (@codex #331 R1)。
 * 送信は JS の form.submit() なので、応答が遅ければ元の document がそのまま
 * 生きており #userId も在る。それを「弾かれた」と読むと、遅いだけを
 * 資格情報の誤りとして報告してしまう (この修正が消そうとしている誤診断)。
 *
 * 送信直前に元のフォームへこの属性を付け、失敗時に「印の無い #userId」が
 * 在るかで判定する = 別 document に置き換わった (= 遷移して戻された) 証拠。
 * 印はこちらのブラウザ内 DOM にしか付かず、外部サービスへは何も送らない。
 */
const REGISTRY_LOGIN_FORM_PROBE_ATTR = "data-pm-login-probe";

/**
 * 「ご利用中の方へ」画面か否かの判定待ち時間(ms)。この待機の前に「確認画面 or 通常メニュー」
 * の着地をログイン全体タイムアウト内で確定させる(応答遅延の吸収)ため、ここは既に着地済みの
 * DOM に対する短時間判定でよい。マーカーが在れば即 resolve、通常メニュー着地なら在らずに短く
 * timeout する。ログイン全体の主タイムアウト(REGISTRY_FETCH_TIMEOUT_MS)より十分短くする。
 */
const FORCE_LOGIN_CONFIRM_DETECT_MS = 1500;

/**
 * ログインフォーム(#userId)の出現待ち時間(ms)の既定上限。閉局時はアプリ入口URL(www側)が
 * 「ご利用中の皆様へ」案内ページ(HTTP200・フォーム無し)を返すことがあり、この待機が
 * 「フォーム不在=閉局/接続不可」の検出を兼ねる。**主タイムアウト(REGISTRY_FETCH_TIMEOUT_MS・
 * 推奨30000)より十分短くする**こと: 同値だと provider 全体タイマー(goto の前から進行)が
 * 先に切れて分類に到達せず、generic timeout に化ける(@codex P1)。実際の待ち時間は
 * resolveLoginFormDetectMs で全体予算から導出する(@codex P2: 予算が小さい設定でも
 * 分類が先に走る余地を残す)。
 */
const LOGIN_FORM_DETECT_MS = 15000;

/**
 * フォーム出現待ち時間を provider 全体予算(REGISTRY_FETCH_TIMEOUT_MS)から導出する純関数。
 * - 予算未設定/不正: 既定の LOGIN_FORM_DETECT_MS(fill 側は Playwright 既定30sのため常に手前で発火)
 * - 予算あり: 予算の半分(上限 LOGIN_FORM_DETECT_MS)= launch/goto に残り半分を確保する
 *   ヒューリスティック。下限1秒(それ未満の予算は設定ミスの域で、どの待ちも成立しない)。
 * goto が予算の大半を食う極端な遅延では依然 provider タイマーが先に切れ generic timeout に
 * なるが、その場合は「サイトが応答しない=タイムアウト」自体が妥当な表示であり誤案内ではない。
 */
export function resolveLoginFormDetectMs(timeoutMs?: number): number {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return LOGIN_FORM_DETECT_MS;
  }
  return Math.max(1000, Math.min(LOGIN_FORM_DETECT_MS, Math.floor(timeoutMs / 2)));
}

/**
 * **ログイン送信後**の待機 (着地待ち / 強制ログインボタン / 確認画面の消失 /
 * ログイン成功要素) に使う既定上限。予算未設定時は Playwright 既定と同値
 * = 現状維持 (予算が無ければ provider 全体タイマーも無く、分類レースが起きない)。
 */
const LOGIN_STEP_DETECT_MS = 30_000;

/**
 * 分類 (ページ再確認 → RegistryFetchError の送出) に必要な余裕 (ms)。
 * provider 全体タイマーより**これだけ手前**で内側の待機を切ることで、
 * catch 節の分類に必ず到達させる。
 */
const LOGIN_CLASSIFY_MARGIN_MS = 2_000;

/**
 * ログイン送信後の待機の**共有デッドライン**(epoch ms)。予算未設定なら null。
 *
 * ⚠これが無いと、送信後の失敗が必ず「タイムアウト」(504) として表示される
 * (総点検 2026-07-27)。理由: 送信後の待機は明示 timeout を持たず
 * page.setDefaultTimeout(timeoutMs) に従うが、その timeoutMs は provider 全体
 * タイマーと同値で、全体タイマーの方が先に進んでいる。よって内側の待機が切れる
 * 前に必ず全体タイマーが切れ、catch 節の分類 (auth_failed / service_hours) に
 * 到達できない。「タイムアウト」表示は運用者に「サイトが重いだけ」と読ませ、
 * 資格情報を疑わせない = 復旧できないまま再試行を繰り返させる。
 *
 * ⚠**各待機に予算の一定割合を配る方式にはしない**(内部レビュー指摘)。
 * 送信後の待機は 5 段あるため、1 段あたり budget/4 だと合計で予算を超えるうえ、
 * 1 段だけ正当に遅い (7.5秒 < 実際に必要な 10秒) ケースで**成功するはずの
 * ログインを auth_failed に化けさせる**。ここは「残り予算をほぼ全部使ってよい。
 * ただし分類の余裕だけ残す」= 共有デッドラインが正しい。
 *
 * ⚠余裕の確保に**下限を置いて外側を追い越してはいけない** (@codex #331 R1)。
 * `max(1000, timeoutMs - 2000)` だと `timeoutMs <= 1000` で内側と外側が同時刻、
 * `timeoutMs = 500` なら内側 1000ms > 外側 500ms で**必ず外側が先に発火**し、
 * この修正が消そうとした「常に timeout 表示」がそのまま残る。
 * 余裕は予算に比例させて縮め (最大 LOGIN_CLASSIFY_MARGIN_MS)、内側の期限は
 * **常に外側より短く**する。極小予算では 0 = 即座に分類へ回す。
 */
export function resolveLoginStepDeadline(startedAt: number, timeoutMs?: number): number | null {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  // 予算が小さいときは余裕も比例縮小する (下限で外側を追い越さないため)。
  const margin = Math.min(LOGIN_CLASSIFY_MARGIN_MS, Math.max(1, Math.ceil(timeoutMs / 2)));
  // 常に外側 (timeoutMs) より短い位置に置く。
  const offset = Math.min(timeoutMs - 1, Math.max(0, timeoutMs - margin));
  return startedAt + Math.max(0, offset);
}

/**
 * 共有デッドラインまでの残り (ms)。デッドライン無しなら既定値。
 *
 * ⚠デッドライン超過後の下限は 1ms にする。1秒などにすると、5段の待機が
 * それぞれ下限ぶん上乗せして**合計が予算を超え**、分類の余裕を食い潰す。
 * 1ms なら Playwright は「既に存在する要素は即 resolve / 無ければ即 timeout」に
 * なるので、デッドライン超過を「今すぐ分類へ回す」意味に使える。
 * (予算そのものが極小な場合は resolveLoginStepDeadline 側の下限 1 秒が効く。)
 */
export function remainingLoginStepMs(deadlineAt: number | null, now: number): number {
  if (deadlineAt === null) return LOGIN_STEP_DETECT_MS;
  return Math.max(1, deadlineAt - now);
}

/**
 * 地番検索ダイアログの候補ロード待ち時間(ms)。クリック直後は「データ取得中・・・」表示で、
 * 候補は非同期で後から入る。この時間内に候補 checkbox 行が現れれば抽出。現れないまま「データ
 * 取得中」が消えていれば **0件**(→ 空配列)、まだ「データ取得中」なら連携遅延(→ timeout)。
 */
const DIALOG_RESULT_TIMEOUT_MS = 15000;

/** 地番検索ダイアログの結果ページを読み進める上限(暴走防止)。超えたら打ち切りログを残す。 */
const MAX_DIALOG_PAGES = 20;

/**
 * 実況パネル用スクショの撮影タイムアウト (1 枚あたり)。best-effort であり、
 * 撮影がハングしても検索本体を遅らせない (失敗時は文字進行のみになる)。
 */
const LIVE_SCREENSHOT_TIMEOUT_MS = 1500;

/**
 * 実況パネル用スクショの 1 検索あたりの撮影時間予算 (累計)。候補が多ページの
 * 場合でも、実況の撮影が検索全体のタイムアウト予算 (REGISTRY_FETCH_TIMEOUT_MS)
 * を無制限に圧迫しないよう有界にする (resolveLoginFormDetectMs が残り予算から
 * 待機時間を導出するのと同じ「実況/診断は本体の予算を食い潰さない」方針)。
 * 予算を使い切った後のステップは文字進行のみ届く (パネルは文字だけでも成立)。
 */
const LIVE_SCREENSHOT_TOTAL_BUDGET_MS = 10_000;

// 実画面HTML(2026-07-14 御社保存)から確定したセレクタ。設計資料 =
// deliverables/registry-calibration/selector-map-20260714.md。
// [確定] = 保存HTMLで実要素を確認済み / [要live] = 動的生成・実サイト実行でのみ確定。
const REGISTRY_SELECTORS = {
  loginId: "#userId", // [確定] 利用者識別番号(maxlength 8)
  password: "#password", // [確定] パスワード(maxlength 14)
  loginSubmit: "button.CForwardLong", // [確定] ログイン実行(onclick=requireCheck)
  loggedIn: 'form[name="logoutForm"]', // [確定] ログイン後の全ページに存在(login画面には無い)
  // 二重ログイン確認画面「ご利用中の方へ」(2026-07-17 本番実測)。
  forceLoginMarker: REGISTRY_FORCE_LOGIN_MARKER, // [確定] この画面固有の hidden input
  forceLoginSubmit: "button.CForwardLong", // [確定] 「強制ログイン」ボタン(onclick=submit)
  // 通常メニュー(請求情報受付メニュー)固有の目印。確認画面には無いため、ログイン送信後に
  // 「確認画面 / 通常メニュー」のどちらへ着地したかの判別に使う(2026-07-17 本番実測)。
  loggedInMenuLink: "a[href*=\"menuClick('FUDOSAN')\"]", // [確定] 「不動産請求」リンク
  // 番号取得(不動産番号での請求)。請求画面で請求方法=不動産番号を選ぶ同一フロー。
  searchMethodNumberRadio: "#fuSeikyuMethodFUDOSAN_NO", // [確定] 請求方法=不動産番号 ラジオ
  searchInput: "#fuFudosanNo", // [要live] 不動産番号入力欄(番号請求時の実操作画面で確定)
  searchResult: "#fudosanIchiranTbl", // [確定] 請求リスト(一覧)テーブル=ヒットの目印
  // ⚠ここから下は**段階②(有料の請求→PDF取得)専用**。段階②が配線されるまで
  //   どの経路からも押さない。理由: 「確定」は無料だが**カートに `未請求` の行を
  //   実際に作る**ので、請求→ダウンロードまで通せない状態で押すと、
  //   失敗するたびに御社のマイページへゴミ行が積み上がる(@codex #344 P1)。
  // ⚠2026-07-31 実サイト校正で是正した2件（旧値はどちらも実物と違っていた）:
  //   - 請求条件の送信 = 旧 `#myPageSeikyu`(マイページ側の課金ボタン=**現行フローでは使わない**。発注者指示=請求リストの #btn_seikyu から直接) → 下記
  //   - PDFダウンロード = 旧 `#download-pdf`(**実サイトに存在しない**) → 下記
  requestConfirmButton: 'button[onclick*="fuBtnForward"]', // [確定] 請求条件の確定(無料・カートへ)
  downloadButton: 'button[onclick*="myPageDownload"]', // [確定] 「表示・保存」(請求済のみ)
  // 所在検索: 実サイトは多段UI。**サイト推奨の「所在選択ダイアログ」方式**で指定する。
  //
  // ⚠**直接入力モードは使わない**(2026-08-04 実機で判明)。所在欄に地番まで
  //   入れるとサイトが赤字で「**請求できない所在です**…直接入力のチェックを外し、
  //   所在選択ボタンをクリックし、ダイアログから所在を選択してください」と出して
  //   先へ進まない。所在(地番区域)は**サイトが持つコード**で確定させるのが正しい。
  searchMethodLocationRadio: "#fuSeikyuMethodSHOZAI", // [確定] 請求方法=所在 ラジオ
  locationTypeLandRadio: "#fuShozaiTypeTOCHI", // [確定] 種別=土地
  locationTypeBuildingRadio: "#fuShozaiTypeTATEMONO", // [確定] 種別=建物
  locationPrefectureSelect: "#fuTodofukenShozai", // [確定] 都道府県 プルダウン
  locationDirectInputCheck: "#fuShozaiChokusetuNyuryoku", // [確定] 所在の直接入力モード(使わない=OFFのまま)
  locationSearchAddress: "#fuChibanKuiki", // [確定] 所在(地番区域)の表示欄。ダイアログが埋める
  locationSearchAddressCode: "#fuChibanKuikiCode", // [確定・2026-08-05 probe] 所在のコード(ダイアログが埋める)
  locationSearchLotBuilding: "#fuChibanKaoku", // [確定] 地番・家屋番号入力
  // ── 所在選択ダイアログ(2026-08-05 本番probe で採取) ───────────────────
  // ⚠**都道府県を選ぶまで所在選択ボタンは押せない**(初期状態は disabled で
  //   `shozaiButton_disable`)。押しても何も起きないため、待ってから押す。
  locationSelectButton: "#fuShozaiSentaku", // [確定] 「所在選択」ボタン(onclick=fuBtnShozaiSentaku)
  locationDialogArea: "#kuikiDialogArea", // [確定] 所在選択ダイアログの器(中身は非同期ロード)
  locationDialogLoading: ".GKuikiDialogWaitMsg", // [確定] 「読み込み中・・・・」(消えるまで待つ)
  locationDialogSelectedPath: ".GKuikiDialogSelectedText", // [確定] 選択済みの階層表示(例「東京都>」)
  locationDialogItem: '#kuikiDialogArea td[id^="GKuiki"]', // [確定] 区域の1件(td・onclick=GKuikiDialogNext/Fixed)。⚠全タブ(全部+五十音)分が同時にDOMへ載る=同一区域が重複して列挙される
  locationDialogAllTab: "#btn-all", // [確定] 「全部」タブ(毎段ここへ寄せてから区域を押す)
  // [確定・2026-08-10 実サイトJS] 「この段で確定してよいか」をサイトが返す隠し欄。
  // GKuikiDialogSetButtonStatus() が `$("#canFix").val()=="YES"` のときだけ
  // 確定ボタンを有効にする=**降り切れたかの唯一の正解**。ページ本体に同名idが
  // 無いとは限らないのでダイアログの器に限定して引く。
  locationDialogCanFix: "#kuikiDialogArea #canFix",
  // ⚠ダイアログの確定/戻る/取消は jQuery UI の buttonpane にあり **id を持たない**。
  //   文言で引く(ページ本体の「確定」= fuBtnForward とは**別物**なので取り違えない)。
  locationDialogButtonPane: ".ui-dialog-buttonpane button", // [確定] 確定/戻る/取消
  // 所在検索フロー(2026-07-17 本番probe確定)。所在→不動産請求→地番検索ダイアログ方式。
  fudosanRequestLink: "a[href*=\"menuClick('FUDOSAN')\"]", // [確定] 不動産請求リンク(=loggedInMenuLinkと同値)
  dialogChibanKaokuListButton: "#fuChibanKaokuIchiran", // [確定] 地番・家屋番号一覧(ダイアログを開く)
  dialogChibanTypeNumeric: "#cbnDlgChibanType0", // [確定] 地番種別=数字/ハイフンのみ
  dialogChibanRangeStart: "#cbnDlgSearchChibanStart", // [確定] 地番範囲(開始)
  // [確定] 地番範囲(終わり)。設計 2026-07-17 probe に
  //   「地番範囲: #cbnDlgSearchChibanStart（〜#cbnDlgSearchChibanEnd）」と記録がありながら、
  //   **実装は開始しか埋めていなかった**(2026-08-15 発注者の指摘で判明)。
  // ⚠開始だけだと「そこから先が全部」返る(同 probe: 丸の内一丁目・範囲1 → 59件)。
  //   **両端に同じ地番を入れて1筆に絞る**のが正しい使い方(発注者の手作業と同じ)。
  dialogChibanRangeEnd: "#cbnDlgSearchChibanEnd",
  dialogSearch: "#cbnDlgChibanSearch", // [確定] ダイアログ内検索(結果は非同期ロード)
  dialogResultTable: "#cbnDlgChibanCheckTbl", // [確定] 候補テーブル(非同期ロード)
  dialogResultCheckbox: "#cbnDlgChibanCheckTbl input[type=checkbox]", // [確定] 候補行チェックボックス
  // 選択の簿記(2026-07-17 probe 確定)。チェックが**サイト側に登録された**証拠は
  // checkbox.checked ではなくこの欄(選択済みの地番・家屋番号)が埋まること。
  dialogSelectedString: "#cbnDlgCheckedChibanString", // [確定] 選択済み地番(値)
  dialogSelectedDisplay: "#cbnDlgCheckedChibanDsp", // [確定] 選択済み地番(表示)
  dialogRoot: "#cbnDlgChibanDialog", // [確定] ダイアログ本体(閉じ確認に使う)
  dialogPageNext: "#cbnDlgBtnPageNext", // [確定] 候補一覧の次ページ(複数ページ時)
  dialogCancel: "#cbnDlgBtnCancel", // [確定] ダイアログ取消(課金しない閉じ方)
  dialogOk: "#cbnDlgBtnOk", // [確定] ダイアログ確定(選んだ地番を親フォームへ反映・無料)
  // 請求事項(謄本種別)のチェックボックス群。2026-07-31 実サイト校正で確定。
  // ⚠ラジオではなく**チェックボックス**で、複数同時に請求できる形。
  // ⚠ON/OFF の実際の割り当ては種別で決まる=REGISTRY_CERTIFICATE_SELECTORS /
  //   certificateCheckboxPlan を正とする(ここは実要素の記録)。
  certificateAllCheck: "#fuAll", // [確定] 全部事項(certificateType=all で ON)
  certificateOwnerCheck: "#fuShoyusya", // [確定] 所有者事項(certificateType=owner で ON・既定)
  // マイページ(請求一覧)。課金とPDF取得はここで行う。
  // ⚠myPageTab(selectTab('tabMy'))は撤去(2026-08-17 probe13)。確定(fuBtnForward)の
  // 着地=請求リスト(/reqf/fudosan-list)にはこのタブが**存在しない**(第1回・第5回の
  // 実課金テストが止まった直接原因=探して無音no-op→#myPageTable待ちtimeout)。
  // 正しい遷移は「行check→【請求】(#btn_seikyu)を直接」(発注者指示 2026-08-18)。
  /** [確定・2026-08-17 probe13] 請求リストの【請求】=**課金**(発注者指示=ここから直接請求)。 */
  fudosanListSeikyuButton: "#btn_seikyu",
  /** [確定・2026-08-17 probe13] 請求リストの行checkbox(#sentaku_N・onclick=chkSentaku(this))。 */
  fudosanListRowCheckbox: 'input[name="sentaku"]',
  /** [確定・2026-08-19 probe15] 請求金額合計(サイトが計算・課金前の裏取りに使う)。 */
  seikyuTotalAmount: "#GSeikyuKingakuGokei",
  myPageTable: "#myPageTable", // [確定] 請求一覧テーブル
  myPageFilter: "#siborikomi", // [確定] 状態の絞り込み(すべて/未請求/請求済…)
  myPageReloadButton: "#myReloadButton", // [要live] 一覧の「最新表示」(請求済への遷移を待つのに使う)
  myPageNextButton: "#myPageTable_next", // [確定] 一覧のページ送り(基準の完全性チェックに使う)
  myPagePrevButton: "#myPageTable_previous", // [確定] 一覧のページ戻し(再走査の先頭復帰に使う)
} as const;

// registryRowMatchesChiban は fudosan-list-select.ts へ移動(課金後の同定
// pickChargedMyPageRow と共有するため)。冒頭で再エクスポート済み。

/**
 * 課金後のダウンロード開始待ち(ms)。⚠page.setDefaultTimeout は通常予算
 * (REGISTRY_FETCH_TIMEOUT_MS・例30秒)のままなので、`waitForEvent("download")` に
 * timeout を渡さないと**ブラウザ側の既定30秒が provider の延長予算(10分)より先に
 * 打ち切り**、支払済みなのに charged_but_failed で台帳固定される(@codex #345 R9 P1)。
 * 課金境界の向こうの待ちには、この明示予算を必ず渡す。
 */
export const PAID_DOWNLOAD_WAIT_MS = 120_000;

/**
 * 種別ごとに「ONにする請求事項」のセレクタ（段階②）。
 * ⚠この2つ以外(#fuChizu/#fuShozai/#fuChieki/#fuZumen/#fuHeisaTokibo)は**常にOFF**。
 * 選んだ種別だけをONにし、それ以外の請求事項は全部OFFにして、余計なものを買わない。
 */
const REGISTRY_CERTIFICATE_SELECTORS: Record<RegistryCertificateType, string> = {
  owner: "#fuShoyusya", // 所有者事項
  all: "#fuAll", // 全部事項
};

/**
 * 請求事項のうち**選んだ種別以外**は必ずOFFにする対象（地図・図面類・閉鎖登記記録）。
 * ⚠`#fuHeisaTokibo`(閉鎖登記記録)は「全部事項の時のみ選択可」= disabled のことがあるので、
 * 操作は DOM click（actionability 待ちで固まらない）で行う。
 */
const REGISTRY_CERTIFICATE_ALWAYS_OFF: readonly string[] = [
  "#fuChizu", // 地図
  "#fuShozai", // 土地所在図/地積測量図
  "#fuChieki", // 地役権図面
  "#fuZumen", // 建物図面/各階平面図
  "#fuHeisaTokibo", // 閉鎖登記記録
];

/**
 * 選んだ種別から「ONにする1つ」と「OFFにする残り全部」を決める（純関数・テスト可能）。
 *
 * ⚠**買うのは1種だけ**。選んだ種別を on に、もう一方の買える種別 + 常時OFFの図面類を
 * すべて off にする。off の中に「もう一方の種別」を必ず含めるのが肝で、これを忘れると
 * サイト初期状態(全部事項ON)のまま所有者事項も足して**2通買う**ことになる。
 */
export function certificateCheckboxPlan(cert: RegistryCertificateType): {
  on: string;
  off: string[];
} {
  const on = REGISTRY_CERTIFICATE_SELECTORS[cert];
  const off = [
    // もう一方の「買える種別」も必ずOFFにする（両方ONで2通買わない）。
    ...Object.values(REGISTRY_CERTIFICATE_SELECTORS).filter((s) => s !== on),
    ...REGISTRY_CERTIFICATE_ALWAYS_OFF,
  ];
  return { on, off };
}

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
    typeof err === "object" && err !== null && (err as { name?: string }).name === "TimeoutError"
  );
}

/**
 * ログイン失敗の分類サマリを作る（運用診断ログ用）。エラー名 + メッセージ先頭行 +
 * Playwright call log の最初の "waiting for ..." 行（あれば）。先頭行だけでは
 * 「page.fill: Timeout 30000ms exceeded.」のように **どのセレクタで** 詰まったかが journal から
 * 読めず、実障害（2026-07-17 ページ期限切れ）で切り分けに再調査を要した。
 * secret（loginId/password の実値）は Playwright エラーに載らない想定だが、防御的に除去する。
 * PII は含めない（このエラー経路のメッセージはセレクタ名/URL/TimeoutError 程度で、所有者名等は含まない）。
 */
export function summarizeRegistryLoginError(err: unknown, secrets: string[] = []): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "unknown";
  const lines = raw.split("\n");
  const waiting = lines.find((l) => l.includes("waiting for"));
  let msg = waiting ? `${lines[0]} (${waiting.trim()})` : lines[0];
  for (const s of secrets) {
    if (s) msg = msg.split(s).join("***");
  }
  return `${name}: ${msg}`.slice(0, 300);
}

/**
 * 所在検索の住所を「都道府県」と「それ以降(市区町村＋町名)」に分解する純関数。
 * 実サイトは都道府県=プルダウン / 所在=直接入力欄 の別入力のため、住所文字列を割る。
 * - 都道府県は **明示列挙** で先頭一致させる(既存 pdf-registry-parser.ts と同方針)。
 *   lazy な `.{1,4}?[都道府県]` は「京都府」の2文字目「都」で早期マッチして誤分解する
 *   (@codex P1) ため使わない。県は「.{2,3}県」で受ける。
 * - どれにも一致しない/先頭が空 → prefecture=null(呼び出し側は全体を所在欄へ)。
 * ※ selectOption に渡す実際の option 値/ラベルの一致は実サイトでのみ確定(=[要live])。
 */
/**
 * 登記情報提供サービスが「所在の指定を受け付けなかった」ことを示す文言。
 *
 * 実機で採取した赤字(2026-08-04):
 *   「請求できない所在です（入力が誤っている又は、所在に外字が含まれているか又は、
 *     入力が不要な小字が含まれている等）。…直接入力のチェックを外し、所在選択ボタンを
 *     クリックし、ダイアログから所在を選択してください。」
 *
 * ⚠**部分一致の語を短くしすぎない**。「所在」だけ等にすると、正常時の見出し
 * (種別/所在 のラベル)にも当たり、候補が出ているのに失敗扱いになる。
 */
const LOCATION_REJECTED_MARKERS: readonly string[] = [
  "請求できない所在",
  "所在に外字が含まれて",
  "所在選択ボタンをクリック",
];

/**
 * ページ本文に上記の拒否文言が含まれるか（純関数・テスト可能）。
 * ⚠受け取るのは本文、返すのは **boolean だけ**。所在を戻り値に載せない。
 */
export function looksLocationRejected(pageText: string): boolean {
  return LOCATION_REJECTED_MARKERS.some((m) => pageText.includes(m));
}

/**
 * ブラウザ側で拒否文言を判定する。⚠`evaluate` の戻り値も boolean に限定し、
 * 所在の写った本文をプロセス側へ持ち出さない(ログ・例外への混入経路を作らない)。
 */
async function isLocationRejectedByProvider(page: RegistryPageLike): Promise<boolean> {
  try {
    // 既存の evaluate は「引数=文字列1つ」の形なので、区切り文字で連結して渡す
    // (U+0001 は画面文言に現れない)。
    const joined = LOCATION_REJECTED_MARKERS.join("\u0001");
    const hit = await page.evaluate((arg: string) => {
      const text = document.body?.innerText ?? "";
      return arg.split("\u0001").some((m) => text.includes(m));
    }, joined);
    return hit === true;
  } catch {
    // 判定できない場合は従来どおり「候補ゼロ」として扱う(誤って失敗扱いにしない)。
    return false;
  }
}

/**
 * 都道府県プルダウンを「表示名」で選ぶ。
 *
 * ⚠**選択肢の値は都道府県コード**(2026-08-05 本番probe: 東京都 = "13")。
 * 住所から切り出せるのは「東京都」という**表示名**なので、そのまま値として
 * 渡しても一致せず選べない。表示名から値を引いてから選ぶ。
 *
 * ⚠ここで選べないと**所在選択ボタンが有効にならない**(都道府県が前提条件)。
 * 黙って先へ進むと所在が空のまま検索して「候補0件」に見え、原因が分からなく
 * なるため、所在の指定の問題として止める。
 */
async function selectPrefectureByLabel(page: RegistryPageLike, label: string): Promise<void> {
  const value = (await page.evaluate((arg: string) => {
    const [sel, want] = arg.split("|");
    const el = document.querySelector(sel) as HTMLSelectElement | null;
    if (!el) return "";
    const norm = (s: string) => s.replace(/\s+/gu, "").trim();
    const hit = Array.from(el.options).find((o) => norm(o.textContent || "") === norm(want));
    return hit ? hit.value : "";
  }, `${REGISTRY_SELECTORS.locationPrefectureSelect}|${label}`)) as string;
  if (!value) {
    // 都道府県名はログに出さない(所在の一部＝PII 方針)。
    console.warn("[registry-search] prefecture option not found");
    throw new RegistryFetchError("location_rejected");
  }
  await page.selectOption(REGISTRY_SELECTORS.locationPrefectureSelect, value);
}

/**
 * 所在選択ダイアログで地番区域を確定させる（B案の中核）。
 *
 * ⚠**ページ本体の「確定」(fuBtnForward) には触れない**。押すとカートに
 * 未請求の行ができる。ここで押すのはダイアログ内の「確定」だけで、
 * 選んだ所在を欄に入れるだけ＝課金にもカートにも触れない。
 * 取り違えを防ぐため、ボタンは**ダイアログのボタン列に限定して**探す。
 *
 * ⚠決められないときは**必ず取消で閉じて location_rejected を投げる**。
 * あいまいなまま進むと、利用者が意図しない土地の謄本を後段で請求する。
 *
 * @returns 確定できたら true。呼び出し側は false を想定しない（例外で返す）。
 */
const MAX_SHOZAI_DIALOG_DEPTH = 8;

async function selectShozaiViaDialog(
  page: RegistryPageLike,
  rest: string,
  report: (label: string) => void,
): Promise<void> {
  const S = REGISTRY_SELECTORS;
  const cancel = async (): Promise<void> => {
    try {
      await page.evaluate((scope: string) => {
        const b = Array.from(document.querySelectorAll(scope)).find(
          (x) => (x.textContent || "").trim() === "取消",
        );
        (b as { click?: () => void } | undefined)?.click?.();
      }, SHOZAI_DIALOG_BUTTON_SCOPE);
    } catch {
      // 閉じられなくても、この後の例外で検索自体は終わる。
    }
  };
  /**
   * サイトが返す「この段で確定してよいか」(YES/NO)。取れなければ空文字。
   *
   * [確定・2026-08-10 実サイトJS] GKuikiDialogSetButtonStatus() は
   * `$("#canFix").val()=="YES"` のときだけ確定ボタンを有効にする。
   * つまり**降り切れたかどうかの唯一の正解はサイトが持っている**。
   * 取れない作り(モック等)では空文字＝従来どおりの判断に任せる。
   */
  const readCanFix = async (): Promise<string> => {
    try {
      const v = (await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as { value?: string } | null;
        return typeof el?.value === "string" ? el.value : "";
      }, S.locationDialogCanFix)) as string | undefined;
      return (v ?? "").trim().toUpperCase();
    } catch {
      return "";
    }
  };
  /**
   * 所在欄がもう埋まっているか。
   *
   * ⚠**最終段の区域は、押した時点でサイトが欄を埋めてダイアログを閉じる**
   * (実サイトJS: td の onclick が GKuikiDialogNext ではなく GKuikiDialogFixed)。
   * このときダイアログの「確定」はもう押せないが、**所在の選択は成功している**。
   */
  const locationFieldFilled = async (): Promise<boolean> => {
    try {
      return (
        (await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as { value?: string } | null;
          return !!el && typeof el.value === "string" && el.value.trim().length > 0;
        }, S.locationSearchAddress)) === true
      );
    } catch {
      return false;
    }
  };

  // 1) 都道府県を選ぶまでボタンは disabled。有効になるまで待ってから押す。
  await page.waitForFunction((arg: unknown) => {
    const b = document.querySelector(String(arg)) as { disabled?: boolean } | null;
    return !!b && b.disabled !== true;
  }, S.locationSelectButton);
  report("所在選択ダイアログを開いています…");
  await page.click(S.locationSelectButton);

  // 2) 中身は後から読み込まれる。「読み込み中・・・・」が消えるまで待つ。
  await page.waitForFunction((arg: unknown) => {
    const [area, loading] = String(arg).split("|");
    const d = document.querySelector(area);
    if (!d || d.children.length === 0) return false;
    return !d.querySelector(loading);
  }, `${S.locationDialogArea}|${S.locationDialogLoading}`);

  // 3) 住所の残りを、**出てきた選択肢に前方一致**で当てながら1段ずつ進む。
  //    ⚠自前の規則(「市区町村郡」で切る)は使わない(@codex #358 P2)。
  //  「東村山市」「四日市市」のように区切り文字を名前の途中に含む自治体で
  //  壊れ、その住所が永久に検索できなくなる。正解はサイトの一覧が持っている。
  let remaining = normalizeForMatch(rest);
  // ⚠「もう確定してよいか」はサイトが `#canFix` で教えてくれる。これを見ずに
  //   「残りが数字だけ＝地番」で降りるのをやめると、**丁目の段を選び残したまま**
  //   確定できずに止まる(2026-08-10 本番実障害・世田谷区若林2-18-3)。
  let canFix = "";
  let depth = 0;
  for (;;) {
    // 3-0) 「全部」タブへ寄せる。⚠区域の td は**全タブ分が DOM に同時に存在**し
    // (隠れタブ= ui-tabs-hide)、既定でどのタブが選ばれるかはサーバー次第。
    // 見えているタブしかクリックできないため、毎段「全部」を明示的に選ぶ。
    // 無い/押せない作りでも続行できる(下の重複畳み+不可視クリックの保険)。
    try {
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const a = el.matches("a") ? el : (el.querySelector("a") ?? el);
        const li = a.closest("li");
        // [確定] 選択中タブの印= ui-tabs-selected (実サイトの GKuikiDialog.js が
        // `li.ui-tabs-selected.ui-state-active a` で選択タブを参照している)。
        // 判定が外れても「選択済みタブをもう一度押す」だけ=無害。
        if (li && li.classList.contains("ui-tabs-selected")) return; // 既に全部タブ
        (a as { click?: () => void }).click?.();
      }, S.locationDialogAllTab);
    } catch {
      // タブ切替に失敗しても、この後の畳み+不可視クリックで進められる。
    }
    const items = (await page.evaluate((sel: string) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        // onclick=`GKuikiDialogNext('402','青ヶ島村',…)` の第1引数=区域コード。
        // 同名の td がタブ重複のコピーか別区域かを見分ける手がかり(表示はしない)。
        const oc = el.getAttribute("onclick") || "";
        const m = /'([^']*)'/.exec(oc);
        return {
          id: (el as { id?: string }).id || "",
          text: (el.textContent || "").trim(),
          code: m ? m[1] : "",
          visible: !el.closest(".ui-tabs-hide"),
        };
      });
    }, S.locationDialogItem)) as ShozaiDialogItem[] | undefined;
    // ⚠段数の上限。住所の残りは1段ごとに必ず短くなるので理屈の上では止まるが、
    //   サイト側の作りが変わっても**待ち続けて「外部サービスの障害」に化けない**
    //   ようにする。実際の階層は市区町村→大字→丁目→小字の4段程度。
    if (depth > MAX_SHOZAI_DIALOG_DEPTH) {
      console.warn("[registry-search] shozai dialog: too deep depth=" + String(depth));
      await cancel();
      throw new RegistryFetchError("location_rejected");
    }
    // この段を読み込み終えた時点でサイトが返す「確定してよいか」。
    canFix = await readCanFix();
    if (!items || items.length === 0) break; // これ以上の段が無い＝ここまでで確定

    // ⚠タブ重複(全部タブ+五十音タブの同一区域コピー)を畳んでから決める。
    // 畳まないと「横浜市」が2件ヒット=「決められない」で**全住所が中止**になる
    // (2026-08-07 本番実障害・候補126件=ユニーク63件×2)。
    // ※ matchDialogItemByPrefix の入口でも畳む(冪等)。ここで畳むのは
    //   失敗ログに「畳んだ後の件数」を出すため。
    const deduped = dedupeShozaiDialogItems(items);
    if (remaining.length === 0) {
      // 住所を使い切った。サイトが確定を許すなら確定へ進む。
      if (canFix !== "NO") break;
      // ⚠まだ段が残るのに住所側に手掛かりが無い＝決められない。当てずっぽうで
      //   選ぶと利用者が意図しない土地の謄本を買うことになるので中止する。
      console.warn(
        "[registry-search] shozai dialog: address exhausted before fixable" +
          " depth=" +
          String(depth) +
          " canFix=" +
          canFix +
          " candidates=" +
          String(deduped.length),
      );
      await cancel();
      throw new RegistryFetchError("location_rejected");
    }
    const hit = matchDialogItemByPrefix(deduped, remaining);
    if (!hit && looksLikeLotTail(remaining) && canFix !== "NO") {
      // ⚠**残っているのが地番なら、それは区域ではない**(@codex #358 P2)。
      // 区域を選び終えた後に数字だけ残るのは正常(地番は別の欄に入れる)。
      // ここで弾くと「丸の内1丁目1-1」のような普通の住所が通らなくなる。
      // ⚠ただし canFix=NO の間は**まだ降り切れていない**(丁目の選び残し)。
      //   地番と早合点して抜けると、確定できないまま止まる(2026-08-10 実障害)。
      break;
    }
    if (!hit) {
      // ⚠**当てずっぽうで選ばない**。別の区域を選ぶと、利用者が意図しない
      // 土地の謄本を後段で請求してしまう。所在の指定として扱って中止する。
      // 選択肢の中身(地名)はログに出さない(PII 方針)。件数と段だけ残す。
      console.warn(
        "[registry-search] shozai dialog: no unique match, candidates=" +
          String(deduped.length) +
          " raw=" +
          String(items.length) +
          " depth=" +
          String(depth) +
          " canFix=" +
          canFix,
      );
      await cancel();
      throw new RegistryFetchError("location_rejected");
    }
    const before = ((await page.evaluate((sel: string) => {
      return (document.querySelector(sel)?.textContent || "").trim();
    }, S.locationDialogSelectedPath)) ?? "") as string;

    if (hit.item.visible === false) {
      // ⚠見えないコピーしか選べなかったとき(全部タブが選べない地域など)。
      // 不可視要素は page.click が actionability 待ちで固まるため、DOM click で
      // onclick を発火させる(ログインボタンの DOM click と同じ前例)。
      await page.evaluate((sel: string) => {
        (document.querySelector(sel) as { click?: () => void } | null)?.click?.();
      }, "#" + hit.item.id);
    } else {
      await page.click("#" + hit.item.id);
    }
    remaining = hit.rest;
    depth++;

    // ⚠**押した時点で所在欄が埋まったら、そこで終わり**(@codex #368 R1 P1)。
    // 最終段の区域は GKuikiDialogFixed が所在欄を埋めてダイアログを閉じる。
    // 閉じ方が「隠すだけ」で区域の td が DOM に残る作りでも、ここで抜ければ
    // **次の段として同じ丁目の一覧を読み直さない**。読み直すと、残った地番
    // (「18-3」)を丁目として突き合わせて中止するか、見えない要素を待って固まる。
    if (await locationFieldFilled()) break;

    // 次の段が読み込まれるまで待つ。
    // ⚠**比較対象は「押す直前の階層表示」**(@codex #358 P1)。以前は
    // ブラウザ側に渡していない変数と比べていたため**常に真**になり、待たずに
    // 次の段へ進んでいた＝古い選択肢を読んで所在を弾いていた。
    // 待てない作りの場合もあるので、失敗しても続行して最後の「確定」で判定する。
    try {
      await page.waitForFunction(
        (arg: unknown) => {
          const {
            pathSel,
            loading,
            area,
            before: was,
          } = JSON.parse(String(arg)) as {
            pathSel: string;
            loading: string;
            area: string;
            before: string;
          };
          const d = document.querySelector(area);
          if (d && d.querySelector(loading)) return false; // まだ読み込み中
          const now = (document.querySelector(pathSel)?.textContent || "").trim();
          return now !== was;
        },
        JSON.stringify({
          pathSel: S.locationDialogSelectedPath,
          loading: S.locationDialogLoading,
          area: S.locationDialogArea,
          before,
        }),
      );
    } catch {
      // 階層表示が変わらない作りでも、最後の「確定」が押せるかで最終判定する。
    }
  }

  // 4) ダイアログの「確定」を押す（⚠ページ本体の確定ではない）。
  //    ⚠**先に所在欄を見る**。最終段の区域は押した時点でサイトが欄を埋めて
  //      ダイアログを閉じる作りがあり(実サイトJS: onclick=GKuikiDialogFixed)、
  //      そのとき確定ボタンはもう押せない。順序を逆にすると**選択に成功して
  //      いるのに「確定が押せない」で失敗**にしてしまう(2026-08-10 実障害)。
  const alreadyFilled = await locationFieldFilled();
  if (!alreadyFilled) {
    const fixed = await page.evaluate((scope: string) => {
      const b = Array.from(document.querySelectorAll(scope)).find(
        (x) => (x.textContent || "").trim() === "確定",
      ) as ({ click?: () => void; disabled?: boolean } & Element) | undefined;
      if (!b || b.disabled === true) return false;
      b.click?.();
      return true;
    }, SHOZAI_DIALOG_BUTTON_SCOPE);
    if (fixed !== true) {
      // 確定できない＝所在が最後まで絞り込めていない。所在の問題として返す。
      // どの段で止まったかをログに残す(地名は残さない=PII 方針)。
      console.warn(
        "[registry-search] shozai dialog: fix button not enabled" +
          " depth=" +
          String(depth) +
          " canFix=" +
          canFix,
      );
      await cancel();
      throw new RegistryFetchError("location_rejected");
    }
  }

  // 5) 所在欄が実際に埋まったことを確認する（埋まらないまま次へ進まない）。
  await page.waitForFunction((arg: unknown) => {
    const el = document.querySelector(String(arg)) as { value?: string } | null;
    return !!el && typeof el.value === "string" && el.value.trim().length > 0;
  }, S.locationSearchAddress);
  report("所在を確定しました");
}

export function splitAddressForLocationSearch(address: string): {
  prefecture: string | null;
  rest: string;
} {
  const m = address.match(/^\s*(東京都|北海道|(?:京都|大阪)府|.{2,3}県)(.*)$/u);
  if (!m) return { prefecture: null, rest: address.trim() };
  return { prefecture: m[1], rest: m[2].trim() };
}

/**
 * 所在検索の失敗診断サマリ(PII安全)。所在/地番は秘匿情報のため、自由記述メッセージ(Playwright
 * の生 message には検索語が混入し得る)は **一切出さず**、エラー名＋Playwright call log の
 * "waiting for <selector>" 行(あれば)のみ返す。セレクタは自前定数=非PII。secret も載らない。
 * summarizeRegistryLoginError と違い message 先頭行を出さない点が肝(所在の部分文字列漏れ防止)。
 */
export function summarizeRegistrySearchError(err: unknown): string {
  const name = err instanceof Error ? err.name : "unknown";
  const raw = err instanceof Error ? err.message : "";
  const waiting = raw.split("\n").find((l) => l.includes("waiting for"));
  return waiting ? `${name}: ${waiting.trim()}` : name;
}

/**
 * 画面構造だけを1行のログに落とす診断（[要live] の区間を実サイトで確定させるため）。
 *
 * ⚠**PII と物件特定情報を出さない**のがこの関数の存在理由。
 *  - 表は `thead` の列見出しと行数だけ読む。**`tbody` のセルは読まない**
 *    （所在・地番・所有者が入るのはそこ）。
 *  - 見えている文字は maskProbeText が数字を全桁 `＊` に潰す。
 *  - 見えている文字は許可リスト（safeLabel）を通す。**伏せ字は匿名化ではない**ため、
 *    既知の固定文言以外は文字数だけにする。onclick は数字と非 ASCII を落とす。
 *  - id / name だけはコード上の静的な識別子なのでそのまま（これが無いと診断の意味が無い）。
 *
 * best-effort。**失敗しても本流に影響させない**（診断のせいで取得が壊れるのは本末転倒）。
 */
/** 画面構造の診断に許す時間。⚠環境変数に依存させない＝未設定の本番でも必ず効く。 */
const PAGE_PROBE_BUDGET_MS = 5000;

async function logRegistryPageProbe(
  page: RegistryPageLike,
  where: string,
  /** 内部予算の上書き(ms)。外側タイマーの残量が既定予算に満たない場面で切り詰める。 */
  budgetMs?: number,
): Promise<void> {
  try {
    // ⚠**診断自身に必ず期限を付ける**(@codex #383 P2)。セレクタ待ちが落ちた原因が
    // 「要素が無い」ではなく**レンダラが応答しない**ことだった場合、page.evaluate は
    // いつまでも解決しない。期限が無いと**元の失敗が投げ直されず**、ブラウザの後始末も
    // 走らず、その物件の取得ロックが解けない＝診断を足したせいで固まる。
    // 環境変数に依存させない(未設定の本番でも必ず効かせる)固定値。
    const json = (await Promise.race([
      page.evaluate(
        (arg) => {
          const { knownSels } = JSON.parse(arg) as {
            probe: string;
            knownSels: string[];
          };
          const text = (el: Element | null): string =>
            (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          const tables = Array.from(document.querySelectorAll("table")).map((tbl) => ({
            id: tbl.id ?? "",
            // ⚠**thead の th だけ**。tbody のセルは読まない（中身＝PII/物件特定情報）。
            headers: Array.from(tbl.querySelectorAll("thead th")).map(text),
            // 行数は件数の手がかり。中身は読まない。
            rowCount: tbl.querySelectorAll("tbody tr").length,
          }));
          // ⚠**表の行の中にある要素は一切見ない**。行アクション（「表示・保存」等）は
          // id を持たず onclick に**その行の識別子**が埋まる作りで、拾うと受付番号相当が
          // 生で出る。見出し・タブ・ページ全体のボタンだけが診断に必要なので、tbody 配下は
          // 丸ごと除外する（「表の中身は読まない」を要素走査にも同じ規則で適用）。
          const outsideRows = (el: Element): boolean => el.closest("tbody") === null;
          const buttons = Array.from(
            document.querySelectorAll("button, input[type=button], input[type=submit]"),
          )
            .filter(outsideRows)
            .map((el) => {
              const b = el as HTMLButtonElement & { value?: string };
              return {
                id: b.id || b.name || "",
                // id も name も無い要素は onclick で識別するしかない。
                // ⚠**ここで短く切らない**(@codex #383 P1・3度目)。60文字で切ると
                // 引数の**閉じ引用符が落ちて**、整形側の「引用符で囲まれた引数」の
                // 判定が一致せず中身が素通りする。**伏せ字は必ず全文に対してかける**。
                // 転送量の歯止めとして広めの上限だけ置き、切れた場合は整形側が
                // 引用符の不整合を見て失敗側へ倒す。
                onclick: (b.getAttribute("onclick") ?? "").slice(0, 2000),
                label: text(b) || b.value || "",
                disabled: b.disabled === true,
              };
            });
          const tabs = Array.from(document.querySelectorAll("a[onclick]"))
            .filter(outsideRows)
            .map((el) => ({
              label: text(el),
              // ⚠上と同じ理由で短く切らない。
              onclick: (el.getAttribute("onclick") ?? "").slice(0, 2000),
            }));
          const known: Record<string, boolean> = {};
          for (const sel of knownSels) {
            try {
              known[sel] = document.querySelector(sel) !== null;
            } catch {
              known[sel] = false;
            }
          }
          return JSON.stringify({ tables, buttons, tabs, known });
        },
        JSON.stringify({
          probe: "page-structure",
          knownSels: [...KNOWN_PROBE_SELECTORS],
        }),
      ),
      // ⚠`sleep` は別の関数内のローカルなのでここでは使えない。診断は自前で待つ。
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("page-probe budget exceeded")),
          budgetMs ?? PAGE_PROBE_BUDGET_MS,
        ).unref?.();
      }),
    ])) as string;
    console.warn(
      `[registry-fetch] page-probe(${where}) ${formatRegistryPageProbe(
        JSON.parse(json) as RegistryPageProbe,
      )}`,
    );
  } catch {
    console.warn(`[registry-fetch] page-probe(${where}) unavailable`);
  }
}

// normalizeChibanForDialog は chiban-input.ts(文字クラスの正本)へ移動した。
// 請求リストの行照合(fudosan-list-select.ts)と共有するため。冒頭で再エクスポート済み。

/**
 * 地番検索ダイアログ(#cbnDlgChibanCheckTbl)の各行(tr)を候補へ変換する。$$eval に渡すため
 * self-contained/serializable(モジュールスコープ非参照)。checkbox を持つ行のみ候補とする。
 * **candidateRef=地番テキスト(#cbnDlgChibanDt_* の textContent、例「１－１」)**。checkbox の id
 * (cbnDlgChibanChk_{N})は **行位置由来でページ跨ぎに再利用され得る**ため candidateRef に使わない
 * (@codex: ページ2の先頭 id がページ1と同じだと切替検出/重複排除が壊れる)。地番は1検索内で一意・
 * ページ跨ぎで安定。地番の無い行/checkbox 無し行(ヘッダ等)は候補にできないので除外。地番/所在は秘匿情報。
 * (2026-07-17 本番probe で行構造確定: td.col_w1>input[checkbox] + td.col_w2#cbnDlgChibanDt_{N})
 */
export function extractChibanCandidateRows(
  els: Element[],
): Array<{ candidateRef: string; lotNumber: string | null }> {
  const out: Array<{ candidateRef: string; lotNumber: string | null }> = [];
  for (const tr of els) {
    const chk = tr.querySelector('input[type="checkbox"]');
    if (!chk) continue;
    const lotCell = tr.querySelector('td[id^="cbnDlgChibanDt_"]');
    const lotNumber = (lotCell?.textContent ?? "").trim();
    if (!lotNumber) continue; // 地番=行の安定一意キー。無ければ候補にできない。
    out.push({ candidateRef: lotNumber, lotNumber });
  }
  return out;
}

/**
 * ブラウザ内評価: 現在のページが「登記情報提供サービスを利用できない状態」かを判定し、
 * 理由を返す。時間外の実挙動は時間帯で異なることを本番で確認済み:
 *  - "closed": jikangai.html(時間外案内)へ誘導された(URL が変わる・2026-07-18 本番確認)
 *    = サイト自身が時間外と言っている → 確定で service_hours。
 *  - "missing": サイト全体が「404｜ページが見つかりません」を返し URL は不変
 *    (夜間の時間外の実挙動・2026-07-20 本番probe で採取)。ただし設定ミス
 *    (REGISTRY_FETCH_LOGIN_PATH の陳腐化)やサイト側停止でも同じ見え方になるため、
 *    時間外かの断定は Node 側の classifyRegistryMissingPage に委ねる(@codex P2)。
 *  - "": 利用可能なページ(ログイン画面等)。
 * Playwright がこの関数をシリアライズしてブラウザ内で実行するため、外部参照を持たない
 * 自己完結関数にする(モジュール内の定数・関数を参照しない)。
 */
export function detectRegistryUnavailablePage(): "closed" | "missing" | "" {
  const href = typeof location !== "undefined" ? location.href : "";
  const title = typeof document !== "undefined" ? document.title : "";
  if (/jikangai/i.test(href)) return "closed";
  if (/^404|ページが見つかりません/.test(title)) return "missing";
  return "";
}

/**
 * 404("missing")検出時の分類(Node 側・純関数)。登記情報提供サービスの利用時間
 * (平日 8:30〜23:00・土日祝日 8:30〜18:00)に照らし、**どのカレンダーでも確実に
 * 時間外**の時刻のみ service_hours と断定する:
 *  - 全日共通の閉局帯(23:00〜翌8:30)
 *  - 土日の 18:00 以降
 * 祝日(曜日は平日だが 18時閉局)はコード上判別できないため、平日 18〜23時や日中の
 * 404 は service_unavailable(時間外の「可能性」として案内・断定しない)に落とす。
 * これにより設定ミス/サイト側停止による営業時間内の 404 を「現在ご利用時間外です」と
 * 誤案内しない(@codex P2)。JST はサーバ TZ に依存せず UTC+9 演算で求める。
 */
export function classifyRegistryMissingPage(now: Date): "service_hours" | "service_unavailable" {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay(); // 0=日, 6=土(JST基準)
  const mins = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const OPEN = 8 * 60 + 30;
  const CLOSE_ALL = 23 * 60;
  const CLOSE_WEEKEND = 18 * 60;
  if (mins < OPEN || mins >= CLOSE_ALL) return "service_hours";
  if ((day === 0 || day === 6) && mins >= CLOSE_WEEKEND) return "service_hours";
  return "service_unavailable";
}

/**
 * 生 Playwright Page を RegistryBrowserPage（高水準セッション抽象）へ適合させる adapter。
 * 失敗は **RegistryFetchError（分類コードのみ）** に正規化し、生メッセージ（URL/入力/selector が
 * 混入しうる）を例外に載せない。中間成果物（Cookie/DL）は close() で破棄する。
 * 実況パネル用のステップスクショのみ例外: live reporter 経由で実行者本人限定の
 * メモリ内 TTL ストア (live-view-store.ts) に短時間保持される (DB/ディスク永続なし)。
 */
function createPlaywrightRegistryPage(
  handles: {
    browser: RegistryBrowserLike;
    context: RegistryContextLike;
    page: RegistryPageLike;
  },
  config: {
    loginPath: string;
    formDetectTimeoutMs?: number;
    /** provider 全体予算 (REGISTRY_FETCH_TIMEOUT_MS)。送信後の待機の共有デッドライン算出に使う。 */
    timeoutMs?: number;
    /** テスト用の時計差し替え。 */
    now?: () => number;
  } = {
    loginPath: DEFAULT_REGISTRY_LOGIN_PATH,
  },
): RegistryBrowserPage {
  const { browser, context, page } = handles;
  const { loginPath } = config;
  const formDetectTimeoutMs = config.formDetectTimeoutMs ?? LOGIN_FORM_DETECT_MS;
  const nowMs = config.now ?? (() => Date.now());
  const budgetMs = config.timeoutMs;
  return {
    async login(input) {
      // 送信後の待機は**共有デッドライン**で切る (各段に割り当てない)。
      // 段ごとに予算の一定割合を配ると、5段あるため合計で予算を超えるうえ、
      // 1段だけ正当に遅いケースで成功するはずのログインを auth_failed に化けさせる。
      const stepDeadlineAt = resolveLoginStepDeadline(nowMs(), budgetMs);
      const stepMs = () => remainingLoginStepMs(stepDeadlineAt, nowMs());
      // 資格情報を**送信したか**。送信前の timeout を「資格情報の誤り」に
      // 誤分類しないための旗 (@codex #331 R1)。送信前はログインフォームが
      // 出ているのが正常なので、フォームの有無では判別できない。
      let submitted = false;
      // 二重ログイン確認画面「ご利用中の方へ」に到達したか。ここで詰まるのは
      // **前回セッションが残っている**問題なので、遅延ではなく認証側の問題として
      // 扱う (@codex #331 R1)。catch から読めるよう try の外で宣言する。
      let sawForceLoginConfirm = false;
      // baseUrl 省略時は documented default を用いる（相対 "/login" 遷移を防ぐ）。
      // loginPath は env（REGISTRY_FETCH_LOGIN_PATH）で上書き可能（live キャリブレーション）。
      const base = input.baseUrl ?? DEFAULT_REGISTRY_BASE_URL;
      const loginUrl = `${base}${loginPath}`;
      try {
        // ⚠送信前の goto / fill も共有デッドラインで縛る (@codex #331 R1)。
        // 縛らないと、遅いページ表示や fill が予算の大半を食ってしまい、
        // 送信後の待機に 1ms しか残らないうえ**catch へ入る前に外側タイマーが
        // 発火**して、約束した分類の余裕が消える (= 資格情報が誤っていても
        // timeout として出る)。
        await page.goto(loginUrl, { timeout: stepMs() });
        // 利用時間外だとログイン画面が出ない(jikangai 誘導 or サイト全体404)。この場合
        // #userId は現れず fill が 30秒 timeout → auth_failed に見えてしまう。利用不可を先に検出し、
        // 「認証失敗」でなく「利用時間外(または接続不可)」として明示する(資格情報を疑わせない)。
        const unavailable = await page.evaluate(detectRegistryUnavailablePage, "");
        if (unavailable === "closed") throw new RegistryFetchError("service_hours");
        if (unavailable === "missing")
          throw new RegistryFetchError(classifyRegistryMissingPage(new Date()));
        // ログインフォームの出現を専用の短い timeout で待つ。閉局時、アプリ入口URL(www側)は
        // jikangai でも 404 でもない「ご利用中の皆様へ」案内ページ(HTTP200)を返すことがあり
        // (2026-07-21 02:30 本番probeで採取・実機の 23:34/02:13 の auth_failed 誤表示の真因)、
        // 上のページ指紋検出をすり抜ける。指紋は変わりうるため、ページの見た目でなく
        // 「フォームが現れなかった」こと自体を合図に時計分類へ落とす(確実閉局帯=service_hours/
        // 判別不能帯=service_unavailable)。auth_failed(資格情報疑い)にはしない。
        // ⚠fill の既定 timeout に頼らない: REGISTRY_FETCH_TIMEOUT_MS 設定時は provider 全体
        // タイマーと同値になり、全体タイマー(goto の前から進行)が先に切れてこの分類に到達
        // できない(@codex P1)。待ち時間は全体予算から導出(resolveLoginFormDetectMs・@codex P2)。
        try {
          // ⚠固定 15 秒 (formDetectTimeoutMs) のままにしない (@codex #331 R1)。
          // goto が予算の大半を食った場合 (例: 30 秒予算のうち 16 秒)、残り 12 秒
          // しか無いのに 15 秒待とうとして、外側タイマーが先に発火する。すると
          // 「フォームが現れない = 閉局/接続不可」の分類 (service_hours /
          // service_unavailable) に到達できず、また generic timeout に化ける。
          // 短い専用待機という性質は保ったまま、残り予算を超えないよう押さえる。
          await page.waitForSelector(REGISTRY_SELECTORS.loginId, {
            timeout: Math.min(formDetectTimeoutMs, stepMs()),
          });
        } catch (err) {
          if (isTimeoutError(err)) {
            const code = classifyRegistryMissingPage(new Date());
            // 運用診断: 開局帯でこれが出続ける場合はセレクタ/導線ドリフトの合図(非PII)。
            console.warn("[registry-login] login form did not appear; classified as", code);
            throw new RegistryFetchError(code);
          }
          throw err;
        }
        await page.fill(REGISTRY_SELECTORS.loginId, input.loginId, {
          timeout: stepMs(),
        });
        await page.fill(REGISTRY_SELECTORS.password, input.password, {
          timeout: stepMs(),
        });
        // 実サイトのログインボタンは `<button type="button" onclick="requireCheck()">` で、
        // requireCheck() が JS で form.submit() する特殊構造。page.click() は隣接する float
        // ヒント要素の被りや actionability チェックで空振りし、送信に至らないことがある
        // （実画面HTMLでのオフライン再現で確認）。DOM の click() を評価で直接発火し、被り/
        // 可視状態に左右されず onclick(=送信) を確実にトリガーする。
        await page.waitForSelector(REGISTRY_SELECTORS.loginSubmit, {
          timeout: stepMs(),
        });
        // 送信直前に元のフォームへ印を付ける (下の分類で「戻ってきたフォーム」と
        // 「まだ遷移していない元のフォーム」を区別するため)。
        await page
          .evaluate((sel) => {
            const parts = sel.split("|");
            const el = document.querySelector(parts[0]);
            if (el) el.setAttribute(parts[1], "1");
            return "";
          }, `${REGISTRY_SELECTORS.loginId}|${REGISTRY_LOGIN_FORM_PROBE_ATTR}`)
          .catch(() => "");
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el && typeof (el as { click?: unknown }).click === "function") {
            (el as unknown as { click: () => void }).click();
          }
        }, REGISTRY_SELECTORS.loginSubmit);
        submitted = true;
        // ログイン送信後の着地を待つ。「確認画面固有マーカー」か「通常メニュー固有リンク」の
        // どちらかが DOM に現れるまで、ログイン全体のタイムアウト内で待つ(グループセレクタ)。
        // 固定の短い猶予だと応答が遅いとき確認画面の到着前に打ち切ってしまい、その後に現れる
        // 確認画面を「二重ログインでない」と誤判定してしまう(@codex 指摘)。どちらかの終端画面を
        // 確定させてから、確認画面か否かを判定する。
        await page.waitForSelector(
          `${REGISTRY_SELECTORS.forceLoginMarker}, ${REGISTRY_SELECTORS.loggedInMenuLink}`,
          { state: "attached", timeout: stepMs() },
        );
        // 「ご利用中の方へ」(二重ログイン確認)が挟まれば「強制ログイン」で突破する。
        // 登記情報提供サービスは1IDにつき同時1セッションのため、前回セッションが残っていると
        // この確認画面が出る(本アプリは自動取得後にログアウトせず close するため残りやすい)。
        // 着地は上で確定済みなので、ここはマーカー有無の短時間判定でよい(在れば強制ログイン、
        // 無ければ通常メニュー着地=想定内としてスキップ)。
        // 確認画面か否かの「判定」だけを内側 try に閉じる(未出現=通常メニュー着地=正常スキップ)。
        // 突破処理(ボタン待ち→click→消失確認)は外側 try 内に置き、その timeout は auth_failed に
        // 正しく落とす(「確認画面ありなのに突破できない」を正常スキップと混同しない)。
        try {
          // マーカーは hidden input のため state:"attached"(DOM 存在で判定)にする。
          // 既定の "visible" 待ちでは hidden 要素が可視にならず永遠に timeout する
          // (2026-07-17 本番実測で確認: これを付けないと確認画面でも突破できない)。
          // ⚠固定 1.5 秒のままにしない (@codex #331 R1)。着地待ちが共有
          // デッドライン近くまで使っていた場合、この 1.5 秒が分類の余裕を食い潰し、
          // 外側のタイマーが先に発火して「常に timeout 表示」に戻る。
          // 短時間判定である性質は保ったまま、残り予算を超えないよう頭を押さえる。
          await page.waitForSelector(REGISTRY_SELECTORS.forceLoginMarker, {
            state: "attached",
            timeout: Math.min(FORCE_LOGIN_CONFIRM_DETECT_MS, stepMs()),
          });
          sawForceLoginConfirm = true;
        } catch (err) {
          // マーカー未出現(timeout)=二重ログインでない=正常。それ以外は本当の失敗として送出。
          if (!isTimeoutError(err)) throw err;
        }
        if (sawForceLoginConfirm) {
          // 「強制ログイン」ボタンの出現を待ってから押す。確認画面のパース途中では marker(hidden)
          // だけが先に attached になり、ボタン未描画のまま evaluate すると querySelector が null で
          // 空振り(無操作)になる。初回ログインの loginSubmit 待ちと同じ race 回避(@codex 指摘)。
          await page.waitForSelector(REGISTRY_SELECTORS.forceLoginSubmit, {
            timeout: stepMs(),
          });
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el && typeof (el as { click?: unknown }).click === "function") {
              (el as unknown as { click: () => void }).click();
            }
          }, REGISTRY_SELECTORS.forceLoginSubmit);
          // 強制ログインを押した「はず」だけでは不十分。loggedIn(logoutForm)は確認画面にも
          // 存在するため、押下が空振り(セレクタ変更/ボタン無効化等)でも直後の loggedIn 待ちが
          // 即満たされ「成功」と誤認しうる(=本番の実障害と同型)。確認画面固有マーカーの
          // 消失(detached)を待ち、確実に画面を抜けたことを積極確認する(@codex 指摘)。
          await page.waitForSelector(REGISTRY_SELECTORS.forceLoginMarker, {
            state: "detached",
            timeout: stepMs(),
          });
        }
        // ログイン成功を固有要素で確認（URL だけで判定しない）。
        await page.waitForSelector(REGISTRY_SELECTORS.loggedIn, {
          timeout: stepMs(),
        });
      } catch (err) {
        // 既に分類済み(service_hours 等)はそのまま保持し、auth_failed で上書きしない。
        if (err instanceof RegistryFetchError) throw err;
        // 締切レース(@codex): 送信後に時間外へ切り替わる(jikangai 誘導/404 化)場合、
        // 着地待ちが timeout する。ここでページを再確認し、利用不可なら時間外系に分類する
        // (auth_failed で資格情報を疑わせない)。評価失敗(ページ閉鎖等)は "" 扱い。
        const unavailableNow = await page
          .evaluate(detectRegistryUnavailablePage, "")
          .catch(() => "");
        if (unavailableNow === "closed") throw new RegistryFetchError("service_hours");
        if (unavailableNow === "missing")
          throw new RegistryFetchError(classifyRegistryMissingPage(new Date()));
        // ⚠待機が予算を使い切っただけのケースを auth_failed にしない
        // (@codex #331 R1)。送信後の待機に内側デッドラインを入れた結果、
        // 「サイトが遅くて着地マーカーが出ない」= 一時的な遅延まで
        // **資格情報の誤りとして報告**されるようになってしまう。これは
        // 「常にタイムアウト表示」の裏返しで、やはり運用者を誤った対処へ導く。
        //
        // 資格情報の誤りは**積極的に検出する**: 登記情報提供サービスは
        // ログインを弾くとログイン画面へ戻す (= #userId が再び DOM に居る)。
        // フォームが戻っていれば auth_failed、そうでなければ「判らない」=
        // 予算切れの timeout として扱う。
        //
        // ⚠残る限界: 弾かれた際にフォームを含まないエラーページを返す実装
        // だった場合、資格情報の誤りが timeout として出る。ただし
        // 「遅いだけを資格情報の誤りと言う」より害が小さい (再試行で解決し得る
        // 案内になる) ため、判別不能時は timeout 側へ倒す。
        if (isTimeoutError(err)) {
          // ⚠送信前 (goto / fill / ログインボタン待ち) の timeout は、そもそも
          // 資格情報を送っていないので auth_failed にしてはいけない
          // (@codex #331 R1)。しかも送信前はログインフォームが出ているのが
          // 正常なので、フォームの有無では判別できず、放置すると
          // 「ログインページが遅い」が「資格情報の誤り」として出る。
          // 「印の無い #userId が在る」= 別 document に置き換わった
          // = 遷移して戻された = 弾かれた証拠。印が残っていれば元のフォームが
          // まだ生きている (= 遷移していない = 遅いだけ)。
          // 確認画面に到達していたなら、そこで詰まったということ = 認証側の問題
          // (前回セッションが残る / 突破ボタンが効かない)。運用者に「再試行」でなく
          // 「ログインセッションを調べる」を促すため auth_failed を保つ。
          const stuckOnForceLoginConfirm = submitted && sawForceLoginConfirm;
          const loginFormBack =
            submitted &&
            !stuckOnForceLoginConfirm &&
            (await page
              .evaluate((sel) => {
                const parts = sel.split("|");
                const el = document.querySelector(parts[0]);
                return !!el && !el.hasAttribute(parts[1]);
              }, `${REGISTRY_SELECTORS.loginId}|${REGISTRY_LOGIN_FORM_PROBE_ATTR}`)
              .catch(() => false));
          if (!loginFormBack && !stuckOnForceLoginConfirm) {
            console.warn(
              submitted
                ? "[registry-login] post-submit wait exhausted the budget; classified as timeout"
                : "[registry-login] pre-submit step timed out; classified as timeout",
            );
            throw new RegistryFetchError("timeout");
          }
        }
        // ログイン確認に至らない = 認証失敗扱い（生メッセージ非載・secret 非露出）。
        // どの段階/種別で失敗したか（TimeoutError とセレクタ名など）は運用診断のため分類ログに残す。
        // secret（loginId/password）に加え、baseUrl/loginUrl（env でカスタム/内部エンドポイントに
        // なり得る＝プロジェクト規約で失敗ログに出さない）も除去する（@codex）。goto 失敗時の
        // Playwright メッセージには遷移先 URL が載るため。
        console.warn(
          "[registry-login] authentication flow failed:",
          summarizeRegistryLoginError(err, [input.loginId, input.password, loginUrl, base]),
        );
        throw new RegistryFetchError("auth_failed");
      }
    },
    async searchByRealEstateNumber(realEstateNumber) {
      // ⚠**段階②(請求→PDF取得)が配線されるまで、実サイトに触れる前に止める**(@codex #344 P1)。
      //
      // 番号取得の実フローは「請求方法=不動産番号 → 番号入力 → **確定** → (マイページで)
      // 請求[課金] → PDF」で、**確定から先が未実装**。2026-07-31 の実サイト校正で
      // 「確定」は無料だが**カートに `未請求` の行を実際に作る**と判明したため、ここで
      // 確定まで進めると PDF に到達できないまま外部に行が残り、**再試行のたびに御社の
      // マイページへゴミ行が積み上がる**。外部の状態を変えてから失敗するくらいなら、
      // **何も触らずに失敗する**方が安全。
      //
      // 呼び出し側から見た結果は従来と同じ `provider_error`（従来も、隠れている
      // ボタンを押そうとして actionability timeout → provider_error に落ちていた）。
      // 変わるのは「カートを汚さない」ことと、原因が診断ログに残ること。
      //
      // 段階②の配線時に、この早期 return を外して
      // 「確定 → マイページで対象行を選択 → 請求 → 請求済を待つ → 表示・保存」を実装する。
      void realEstateNumber; // 実サイトへは送らない（未配線のため）
      console.warn(
        "[registry-fetch] number-based obtain is not wired yet (stage 2 pending); " +
          "refusing before touching the external request cart",
      );
      throw new RegistryFetchError("provider_error");
    },
    async searchByLocation(input) {
      // 実サイトの所在検索(2026-07-17 本番probe で全確定)。ログイン後の「請求情報受付メニュー」
      // には所在検索が無く、「不動産請求」画面へ遷移した先にある。さらに検索実行は「次へ」一発では
      // なく「地番・家屋番号一覧」ボタン→地番検索ダイアログ(非同期ロード)方式。段階①は候補一覧
      // (地番)を返すまでで **課金しない**: 確定(#cbnDlgBtnOk)・請求(#btn_seikyu)は押さず、
      // キャンセルで閉じる。
      //   ①「不動産請求」リンクを DOM click で遷移(javascript:menuClick は a.click で発火)
      //   ②請求方法=所在 ③種別(家屋番号あり=建物/なし=土地) ④都道府県 select
      //   ⑤直接入力チェック → 所在(市区町村以下) ⑥地番 ⑦地番一覧ボタン→ダイアログ
      //   ⑧ダイアログ地番種別+範囲 → 検索(非同期) ⑨checkbox 行が現れるまで待つ → 抽出
      //   ⑩キャンセルで閉じる(課金しない)
      // セットアップ由来失敗は provider_error、結果待ち timeout は timeout に分類。診断ログは
      // secret/PII(所在/地番)を除去して残す。
      // 種別(土地/建物)を家屋番号の有無で判定し、検索キーも種別に合わせる(@codex P1)。
      // 建物なら家屋番号、土地なら地番で検索する(建物なのに地番で検索すると別物になる)。
      // 選び方は純関数に集約(検査側とずれない・@codex #394 R8 P2)。
      const { isBuilding, value: rawKey } = effectiveLocationIdentifier(input);
      // ダイアログの数字/ハイフン専用欄に合わせて正規化(「1番1」→「1-1」等・@codex P1)。
      const searchKey = normalizeChibanForDialog(rawKey);
      // 実況パネル: ステップは即時に文字で通知し、viewport スクショ (JPEG) は
      // fire-and-forget で撮って後からその step に添付する (@codex R6: 撮影の
      // await を検索本体のチェーンに乗せると、実況を有効にしただけで本体の
      // timeout 予算 (REGISTRY_FETCH_TIMEOUT_MS) を消費してしまう。本方式では
      // 本体への追加待ち時間はゼロ)。
      // best-effort: 撮影失敗・reporter 例外のいずれでも検索本体を妨げない。
      // ⚠スクショには所在・地番が写る = live-view-store が実行者本人限定・
      // メモリ内 TTL のみで保持 (ログ・監査・ディスクには一切出さない)。
      // ログイン画面は provider 側で撮影を省略済み (この関数はログイン後のみ)。
      // 撮影は同時 1 枚 + 1 枚 LIVE_SCREENSHOT_TIMEOUT_MS + 累計
      // LIVE_SCREENSHOT_TOTAL_BUDGET_MS で有界 (超過後は文字進行のみ)。
      let liveShotBudgetMs = LIVE_SCREENSHOT_TOTAL_BUDGET_MS;
      let liveShotInFlight = false;
      /**
       * 中止の節目。⚠**外から処理を殺さない**。ここで自分から throw して、外部
       * サイトを安全な状態のまま抜ける。
       * ⚠**課金後は止まらない**。請求を押した後に止めると「お金は払ったのに
       * 書類が手に入らない」状態を作るため、取得しきる方を選ぶ (cancel-safety.ts)。
       */
      const checkCancel = (): void => {
        const live = input.live;
        if (!live?.isCancelRequested) return;
        let requested = false;
        try {
          requested = live.isCancelRequested() === true;
        } catch {
          return; // 実況の不調で検索を壊さない
        }
        // ⚠この関数は**候補検索(段階①)**で、お金は一切動かない経路。
        // よって charged は常に false = 中止はいつでも安全に受け付けられる。
        // 有料取得(段階②)には**中止を用意しない**(下の設計判断を参照)。
        const decision = decideCancel(requested, false);
        if (decision.kind === "stop") {
          try {
            live.step(CANCEL_ACCEPTED_MESSAGE);
          } catch {
            /* 実況は best-effort */
          }
          throw new RegistryFetchError("cancelled");
        }
        if (decision.kind === "ignore-charged") {
          try {
            live.step(CANCEL_IGNORED_CHARGED_MESSAGE);
          } catch {
            /* 実況は best-effort */
          }
        }
      };
      const reportLive = (label: string): void => {
        // ⚠ステップを進めるたびに中止を見る。節目を別で数え上げると入れ忘れる。
        checkCancel();
        const live = input.live;
        if (!live) return;
        let seq = -1;
        try {
          seq = live.step(label);
        } catch {
          // reporter は非 throw 契約だが、実況が検索を壊さない二重防御。
          return;
        }
        if (seq < 0) return;
        if (liveShotBudgetMs <= 0 || liveShotInFlight) return;
        liveShotInFlight = true;
        const startedAt = Date.now();
        // 検索本体の await チェーンには乗せない (void)。page.close 後の解決も
        // catch で握り潰される。
        void (async () => {
          try {
            const raw = await page.screenshot?.({
              type: "jpeg",
              quality: 55,
              timeout: Math.min(LIVE_SCREENSHOT_TIMEOUT_MS, liveShotBudgetMs),
            });
            if (raw) {
              live.attachShot(seq, raw instanceof Uint8Array ? raw : new Uint8Array(raw));
            }
          } catch {
            // 撮影失敗は文字進行のみで続行 (詳細は log にも出さない)。
          } finally {
            liveShotBudgetMs -= Date.now() - startedAt;
            liveShotInFlight = false;
          }
        })();
      };
      // DOM click(login と同じ evaluate 経由・javascript: href/被りに左右されず onclick を発火)。
      const domClick = (sel: string) =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el && typeof (el as { click?: unknown }).click === "function") {
            (el as unknown as { click: () => void }).click();
          }
        }, sel);
      try {
        await page.waitForSelector(REGISTRY_SELECTORS.fudosanRequestLink, {
          state: "attached",
        });
        reportLive("ログインしました。不動産請求メニューへ移動します");
        await domClick(REGISTRY_SELECTORS.fudosanRequestLink);
        await page.waitForSelector(REGISTRY_SELECTORS.searchMethodLocationRadio);
        reportLive("請求方法「所在指定」を選択しています");
        await page.click(REGISTRY_SELECTORS.searchMethodLocationRadio);
        // 家屋番号があれば建物、無ければ土地(登記の種別区分)。
        await page.click(
          isBuilding
            ? REGISTRY_SELECTORS.locationTypeBuildingRadio
            : REGISTRY_SELECTORS.locationTypeLandRadio,
        );
        const { prefecture, rest } = splitAddressForLocationSearch(input.address);
        // ⚠**都道府県が取れない住所は、ここで止める**(@codex #358 P2)。
        // 所在選択ボタンは都道府県を選ぶまで押せない作りなので、無いまま進むと
        // ボタンが有効にならず待ち続け、最後は「外部サービスの障害」に化ける。
        // 実際は**住所を直せば通る**話なので、そう伝わる分類で止める。
        if (!prefecture) {
          console.warn("[registry-search] address has no prefecture");
          throw new RegistryFetchError("location_rejected");
        }
        // ⚠選択肢の値は都道府県**コード**なので、表示名から引いて選ぶ。
        await selectPrefectureByLabel(page, prefecture);
        // ⚠**直接入力は使わない**(発注者判断=B案)。所在欄に住所を打ち込む方式は
        // 実機で「請求できない所在です…所在選択ボタンからダイアログで選んで
        // ください」と赤字で止まる。登記の所在は住所ではなく**地番区域**で、
        // サイトの持つコードで確定させないと請求まで進めない。
        await selectShozaiViaDialog(page, rest.length > 0 ? rest : input.address, reportLive);
        // 検索キーは種別に合わせた番号(建物=家屋番号 / 土地=地番)。
        if (searchKey.length > 0) {
          await page.fill(REGISTRY_SELECTORS.locationSearchLotBuilding, searchKey);
        }
        reportLive("所在と地番・家屋番号を入力しました");
        // 地番検索ダイアログを開く → 地番種別(数字/ハイフン) + 範囲 → 検索(非同期)。
        await page.click(REGISTRY_SELECTORS.dialogChibanKaokuListButton);
        await page.click(REGISTRY_SELECTORS.dialogChibanTypeNumeric);
        if (searchKey.length > 0) {
          // ⚠**両端に同じ値**を入れて1筆に絞る。開始だけだと「そこから先が全部」返る。
          await page.fill(REGISTRY_SELECTORS.dialogChibanRangeStart, searchKey);
          await page.fill(REGISTRY_SELECTORS.dialogChibanRangeEnd, searchKey);
        }
        reportLive("地番検索を実行しています…");
        await page.click(REGISTRY_SELECTORS.dialogSearch);
      } catch (err) {
        // ⚠**分類済みの失敗はそのまま通す**(@codex #357 P2)。ここで一律に
        // provider_error へ潰すと、利用者が押した「中止」まで**外部サービスの
        // 障害(502)**として扱われ、実況にも監査にも「provider_error」と残る。
        // 中止は成功であって障害ではない。後段の catch は既にこの形。
        if (err instanceof RegistryFetchError) throw err;
        console.warn(
          "[registry-search] location search setup failed:",
          summarizeRegistrySearchError(err),
        );
        throw new RegistryFetchError("provider_error");
      }
      try {
        // 非同期ロード(クリック直後は「データ取得中・・・」)。候補 checkbox 行を待つ。
        try {
          await page.waitForSelector(REGISTRY_SELECTORS.dialogResultCheckbox, {
            state: "attached",
            timeout: DIALOG_RESULT_TIMEOUT_MS,
          });
        } catch (waitErr) {
          if (!isTimeoutError(waitErr)) throw waitErr;
          // checkbox が出ない = 「0件」か「まだロード中」。@codex P2: ロード完了(「データ取得中」が
          // 消えた)なら真の 0件 → 空配列。まだロード中なら連携遅延 → timeout(候補ゼロと区別)。
          const loaded = await page.evaluate((sel) => {
            const t = document.querySelector(sel);
            return !!t && !/データ取得中/.test(t.textContent ?? "");
          }, REGISTRY_SELECTORS.dialogResultTable);
          if (!loaded) {
            console.warn(
              "[registry-search] result load timed out:",
              summarizeRegistrySearchError(waitErr),
            );
            throw new RegistryFetchError("timeout");
          }
          // ⚠**候補ゼロと決める前に、サイトが所在を拒否していないか見る**
          // (2026-08-04 実機で判明)。サイトは「請求できない所在です…」と赤字で
          // 出すのに、こちらは候補チェックボックスの有無しか見ておらず「0件」と
          // 報告していた。例外も出ないため journald にも何も残らず、
          // **利用者は「登記の無い物件」と誤解し、開発側も原因に辿り着けない**。
          // ⚠判定関数が返すのは **boolean だけ**(所在が写った本文は持ち出さない)。
          if (await isLocationRejectedByProvider(page)) {
            reportLive(
              "所在の指定が受け付けられませんでした（住所に地番まで含まれている可能性があります）",
            );
            // 所在は載せない。分類コードのみで上位へ伝える。
            console.warn("[registry-search] location rejected by provider");
            await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
            throw new RegistryFetchError("location_rejected");
          }
          reportLive("候補は見つかりませんでした (0 件)。サイト側で一時的に0件になることがあります。時間をおかず、もう一度お試しください");
          await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
          return [];
        }
        // 結果は複数ページに渡り得る(#cbnDlgBtnPageNext)。1ページ目だけ読んで閉じると後続ページの
        // 候補を取りこぼす(@codex P1)。次ページボタンが有効な限り読み進める(candidateRef で重複排除・
        // 上限 MAX_DIALOG_PAGES で打ち切りログ)。⚠複数ページ時のDOM挙動は[要live]未観測のため防御的:
        // 次ボタンが無い/無効/新規候補ゼロ/次ページ読込 timeout のいずれでも安全に停止する(最悪でも
        // 1ページ目=従来挙動=退行なし)。
        const collected: Array<{ candidateRef: string; lotNumber: string | null }> = [];
        const seen = new Set<string>();
        let capped = false;
        for (let pageNo = 0; ; pageNo++) {
          reportLive(`候補一覧を読み取っています (${pageNo + 1} ページ目)`);
          const rows = (await page.$$eval(
            `${REGISTRY_SELECTORS.dialogResultTable} tr`,
            extractChibanCandidateRows,
          )) as Array<{ candidateRef: string; lotNumber: string | null }>;
          let added = 0;
          for (const r of rows) {
            if (r.candidateRef && !seen.has(r.candidateRef)) {
              seen.add(r.candidateRef);
              collected.push(r);
              added++;
            }
          }
          // 次ページボタンが存在し有効(非 disabled・非表示でない)か。
          const hasNext = await page.evaluate((sel) => {
            const b = document.querySelector(sel) as {
              disabled?: boolean;
            } | null;
            if (!b) return false;
            if (b.disabled) return false;
            const style = getComputedStyle(b as unknown as Element);
            return style.display !== "none" && style.visibility !== "hidden";
          }, REGISTRY_SELECTORS.dialogPageNext);
          if (!hasNext) break;
          if (pageNo + 1 >= MAX_DIALOG_PAGES) {
            capped = true;
            break;
          }
          if (added === 0) break; // 進捗なし(想定外DOM/同一ページ)→安全停止
          // 次ページボタンは通常ボタン(login のような被り/js href ではない)ので page.click で押す。
          const prevFirstRef = rows[0]?.candidateRef ?? "";
          await page.click(REGISTRY_SELECTORS.dialogPageNext);
          try {
            // @codex P1: 単に checkbox の attached を待つと、旧ページの checkbox が残っている間に
            // 即 resolve し、旧行を再読込→全て seen 済み→added===0 で1ページ目しか返らない。
            // 「ページが実際に切り替わった(1行目の**地番**が前ページと変わり、ロード完了)」まで待つ。
            // 判定は checkbox の id(位置由来・ページ跨ぎ再利用の恐れ)ではなく **地番テキスト**で行う。
            await page.waitForFunction(
              (arg) => {
                const { tableSel, prevRef } = arg as {
                  tableSel: string;
                  prevRef: string;
                };
                const t = document.querySelector(tableSel);
                if (!t) return false;
                if (/データ取得中/.test(t.textContent ?? "")) return false;
                const firstCell = t.querySelector('td[id^="cbnDlgChibanDt_"]');
                const val = (firstCell?.textContent ?? "").trim();
                return val !== "" && val !== prevRef;
              },
              {
                tableSel: REGISTRY_SELECTORS.dialogResultTable,
                prevRef: prevFirstRef,
              },
              { timeout: DIALOG_RESULT_TIMEOUT_MS },
            );
          } catch (pageErr) {
            if (!isTimeoutError(pageErr)) throw pageErr;
            break; // 次ページに切り替わらない(読めない)→ここまでで確定(退行はしない)
          }
        }
        if (capped) {
          // 上限で打ち切った=候補を全ては返せていない(無言の truncation を避け運用に残す)。
          console.warn("[registry-search] candidate pages capped at", MAX_DIALOG_PAGES);
        }
        reportLive(
          `候補の読み取りが完了しました (${collected.length} 件)。請求はせずに閉じます (課金なし)`,
        );
        // 課金しない: ダイアログはキャンセルで閉じる(確定/請求は押さない)。
        await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
        // 行の番号値(#cbnDlgChibanDt_*)は種別に応じて地番 or 家屋番号。種別に合う欄へ入れる(@codex P1)。
        return collected.map((r) => ({
          candidateRef: r.candidateRef,
          address: input.address,
          lotNumber: isBuilding ? null : r.lotNumber,
          buildingNumber: isBuilding ? r.lotNumber : null,
          realEstateNumber: null,
        }));
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        console.warn(
          "[registry-search] location result read failed:",
          summarizeRegistrySearchError(err),
        );
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
        throw new RegistryFetchError("provider_error");
      }
    },
    async fetchByLocationCandidate(input) {
      // 段階②(2026-07-31): 所在検索で選ばれた候補(地番/家屋番号)の**有料取得**。
      // フロー(実サイト校正= deliverables/registry-calibration/stage2-flow-20260731.md):
      //   [課金前] ①不動産請求へ遷移 ②条件入力 ③地番ダイアログ検索 ④対象行を check→確定
      //           ⑤請求事項=所有者事項のみに揃える(検証つき) ⑥「確定」(無料・カートに未請求で載る)
      //           ⑦マイページで対象行(未請求×所在一致×最新)を1件だけ特定して check
      //   [課金]   ⑧「請求」 ⑨状態が「請求済」になるまで待つ ⑩同じ行を選び「表示・保存」→PDF
      // ⚠⑧より前の失敗は provider_error/not_found(お金は動いていない)。
      // ⚠⑧より後の失敗は **charged_but_failed**(課金済みの可能性。呼び出し側が再試行禁止+台帳記録)。
      // ⚠[要live] ⑥以降の画面遷移・請求後の反映時間は実課金テストで最終確定する。
      // 外側の provider 予算に対する残量計算用。⚠基準は provider が withPaidTimeout の
      // **開始時刻**で確定して渡してくる deadline(@codex #386 R2: ここで測り直すと
      // ログインが食った時間ぶん残量を過大評価し、リトライが外側 timeout を再び踏む)。
      const paidDeadline =
        typeof input.paidDeadlineAt === "number" && Number.isFinite(input.paidDeadlineAt)
          ? input.paidDeadlineAt
          : null;
      // 選び方は純関数に集約(検査側とずれない・@codex #394 R8 P2)。
      const { isBuilding, value: rawTarget } = effectiveLocationIdentifier(input);
      const targetKey = normalizeChibanForDialog(rawTarget);
      // 課金前(請求リストの行選択)と課金後(マイページの行同定)で共有する
      // 期待所在(都道府県込み)。確定前の #fuChibanKuiki 読み取り時に確定する。
      let expectedKuiki = "";
      // 課金前に控える既存行の受付番号(基準)。課金後の同定は基準に無い行だけ。
      const baselineTrIds = new Set<string>();
      // 請求リストで選んだ行の番号(料金の裏取りに使う)。
      let pickedRowIndex = -1;
      if (targetKey.length === 0) {
        // 取得対象(地番/家屋番号)が無い候補は買えない(課金前・fail-closed)。
        throw new RegistryFetchError("provider_error");
      }
      const domClick = (sel: string) =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el && typeof (el as { click?: unknown }).click === "function") {
            (el as unknown as { click: () => void }).click();
          }
        }, sel);
      // PageLike の evaluate は string 引数のみ(既存契約)なので、複合引数は JSON で渡す。
      const sleep = (ms: number) =>
        page.waitForFunction(() => false, undefined, { timeout: ms }).catch(() => {});

      // 実況(2026-08-15)。検索側 reportLive と同じ contract。
      // ⚠**2026-08-23 から中止も見る**(発注者指示「確定ボタンを押すまでは中止
      // ボタンを出してください」)。課金の直前までは 1 円も動かないので、
      // 節目ごとに中止を確認して**自分で**止まる(外から処理を殺さない)。
      // 撮影は本体の await チェーンに乗せない・累計予算制も検索側と同じ。
      // ⚠label は固定文言のみ。所在・地番・資格情報を**絶対に**埋め込まない
      // (スクショには写るが、閲覧はストア側で実行者本人に限定される)。
      let liveShotBudgetMs = LIVE_SCREENSHOT_TOTAL_BUDGET_MS;
      let liveShotInFlight = false;
      const reportLive = (label: string): void => {
        const live = input.live;
        if (!live) return;
        let seq = -1;
        try {
          seq = live.step(label);
        } catch {
          return; // 実況の失敗で取得本体を壊さない(非throw契約の二重防御)
        }
        if (seq < 0) return;
        if (liveShotBudgetMs <= 0 || liveShotInFlight) return;
        liveShotInFlight = true;
        const startedAt = Date.now();
        void (async () => {
          try {
            const raw = await page.screenshot?.({
              type: "jpeg",
              quality: 55,
              timeout: Math.min(LIVE_SCREENSHOT_TIMEOUT_MS, liveShotBudgetMs),
            });
            if (raw) {
              live.attachShot(seq, raw instanceof Uint8Array ? raw : new Uint8Array(raw));
            }
          } catch {
            // 撮影失敗は文字進行のみで続行。
          } finally {
            liveShotBudgetMs -= Date.now() - startedAt;
            liveShotInFlight = false;
          }
        })();
      };

      /**
       * 課金前の節目で中止を確認し、押されていれば**課金せず**止まる。
       *
       * ⚠**課金の直前(`endCancelable`)より前でしか呼ばない**。課金後に止めると
       *   「払ったのに書類が無い」を作る(その判断は cancel-safety.ts が持つ)。
       * ⚠止めたことを実況に残す(黙って終わると「壊れた」と見える)。
       * ⚠節目は**複数**要る。1か所だけだと「押したのに最後まで走る」時間帯が残る。
       */
      const abortIfCancelledPaid = (): void => {
        if (input.live?.isCancelRequested?.() !== true) return;
        try {
          input.live?.step(CANCEL_ACCEPTED_MESSAGE);
        } catch {
          /* 実況は best-effort */
        }
        throw new RegistryFetchError("cancelled");
      };

      // ---- 課金前ゾーン(①〜③: ナビゲーション+条件入力+ダイアログ検索) ----
      try {
        await page.waitForSelector(REGISTRY_SELECTORS.fudosanRequestLink, {
          state: "attached",
        });
        abortIfCancelledPaid();
        reportLive("ログインしました。不動産請求メニューへ移動します(まだ課金されていません)");
        await domClick(REGISTRY_SELECTORS.fudosanRequestLink);
        await page.waitForSelector(REGISTRY_SELECTORS.searchMethodLocationRadio);
        await page.click(REGISTRY_SELECTORS.searchMethodLocationRadio);
        await page.click(
          isBuilding
            ? REGISTRY_SELECTORS.locationTypeBuildingRadio
            : REGISTRY_SELECTORS.locationTypeLandRadio,
        );
        const { prefecture, rest } = splitAddressForLocationSearch(input.address);
        // ⚠**都道府県が取れない住所は、ここで止める**(@codex #358 P2)。
        // 所在選択ボタンは都道府県を選ぶまで押せない作りなので、無いまま進むと
        // ボタンが有効にならず待ち続け、最後は「外部サービスの障害」に化ける。
        // 実際は**住所を直せば通る**話なので、そう伝わる分類で止める。
        if (!prefecture) {
          console.warn("[registry-search] address has no prefecture");
          throw new RegistryFetchError("location_rejected");
        }
        // ⚠選択肢の値は都道府県**コード**なので、表示名から引いて選ぶ。
        await selectPrefectureByLabel(page, prefecture);
        // ⚠**直接入力は使わない**(発注者判断=B案)。所在欄に住所を打ち込む方式は
        // 実機で「請求できない所在です…所在選択ボタンからダイアログで選んで
        // ください」と赤字で止まる。登記の所在は住所ではなく**地番区域**で、
        // サイトの持つコードで確定させないと請求まで進めない。
        await selectShozaiViaDialog(
          page,
          rest.length > 0 ? rest : input.address,
          // 有料取得の経路には実況の通知先が無い(候補検索とは別メソッド)。
          // 所在の確定そのものは同じ手順なので、通知だけ空にして共用する。
          () => {},
        );
        await page.fill(REGISTRY_SELECTORS.locationSearchLotBuilding, targetKey);
        await page.click(REGISTRY_SELECTORS.dialogChibanKaokuListButton);
        await page.click(REGISTRY_SELECTORS.dialogChibanTypeNumeric);
        // ⚠所在検索と**同じ入れ方**にする(両端に同じ値=1筆に絞る)。片方だけ直すと
        //   無料検索と有料取得で結果集合がずれる([同種の穴は全箇所を洗ってから直す])。
        await page.fill(REGISTRY_SELECTORS.dialogChibanRangeStart, targetKey);
        await page.fill(REGISTRY_SELECTORS.dialogChibanRangeEnd, targetKey);
        abortIfCancelledPaid();
        reportLive("所在と地番を入力し、地番検索を実行しています(まだ課金されていません)");
        await page.click(REGISTRY_SELECTORS.dialogSearch);
      } catch (err) {
        // ⚠**分類済みの失敗はそのまま通す**(@codex #358 P2)。ここで一律に
        // provider_error へ潰すと、所在が決められなかった場合
        // (location_rejected) まで「外部サービスの障害(502)」になり、画面に
        // **「住所を直せば通る」という案内が出ない**。利用者は原因が分からない
        // まま**有料の取得を押し直す**ことになる。候補検索側は既にこの形。
        if (err instanceof RegistryFetchError) throw err;
        console.warn(
          "[registry-fetch] paid flow setup failed (not charged):",
          summarizeRegistrySearchError(err),
        );
        throw new RegistryFetchError("provider_error");
      }

      // マイページ一覧の絞り込み(@codex #345 R5 P1)。基準・行選択は「未請求」だけに
      // 絞る=課金され得る行の全体集合を最小化し、ページ分割の可能性も下げる。
      // 値は option の表示ラベルで選ぶ(実 value は[要live]のため)。change を発火して
      // 一覧の再描画を促す(ハンドラ未接続でも後段のページ分割チェックが守る)。
      // 戻り値=change を**発火したか**(@codex #390 R6: 発火直後は表の再描画が
      // 非同期に走るため、呼び出し側は猶予と安定確認を足す)。
      const applyMyPageFilter = async (label: string): Promise<boolean> =>
        (await page.evaluate(
          (json) => {
            const { filterSel, label } = JSON.parse(json) as {
              filterSel: string;
              label: string;
            };
            const el = document.querySelector(filterSel) as HTMLSelectElement | null;
            if (!el) return false;
            const opt = Array.from(el.options).find((o) => (o.textContent ?? "").trim() === label);
            if (!opt) return false;
            if (el.value !== opt.value) {
              el.value = opt.value;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
            return false;
          },
          JSON.stringify({
            filterSel: REGISTRY_SELECTORS.myPageFilter,
            label,
          }),
        )) === true;
      // 絞り込みが**実際に「すべて」になっている**ことの実測(@codex #390 R4 P1)。
      // select には前回操作の選択が残り得る。掛けたつもりを信用せず、選択中
      // option のラベルで確認する(確認できない回の走査は基準/同定に使わない)。
      const verifyAllFilter = async (): Promise<boolean> =>
        (await page.evaluate(
          (json) => {
            const { filterSel } = JSON.parse(json) as { filterSel: string };
            const el = document.querySelector(filterSel) as HTMLSelectElement | null;
            const opt = el?.selectedOptions?.[0];
            return ((opt?.textContent ?? "").trim() === "すべて") === true;
          },
          JSON.stringify({
            probe: "filter-verify",
            filterSel: REGISTRY_SELECTORS.myPageFilter,
          }),
        )) === true;
      // 一覧に次ページがあるか。基準/行選択は**1ページに収まっている時だけ**進める
      // (見えていない行がある状態の一覧は、基準としても選択対象としても不完全)。
      const pagerEnabled = async (sel: string): Promise<boolean> =>
        (await page.evaluate((s) => {
          const b = document.querySelector(s) as {
            disabled?: boolean;
            className?: string;
          } | null;
          if (!b || b.disabled) return false;
          const st = getComputedStyle(b as unknown as Element);
          if (st.display === "none" || st.visibility === "hidden") return false;
          // dataTables 系は disabled を class で表すことがある
          return !/disabled/.test(String(b.className ?? ""));
        }, sel)) === true;
      const myPageHasNext = () => pagerEnabled(REGISTRY_SELECTORS.myPageNextButton);
      // (撤去 2026-08-18) myPageIsSinglePage は旧マイページ課金前段専用(消費者消滅)。
      // 再走査の前に一覧を先頭ページへ戻す(@codex #345 R6 P1)。      // 再走査の前に一覧を先頭ページへ戻す(@codex #345 R6 P1)。前へボタンが有効な間
      // 押し戻す(最大10回)。戻さないと前回の走査で末尾ページに居座り、リロード後に
      // 先頭側へ挿入された行を**残りの全 attempt で見逃す**。
      const resetMyPageToFirst = async (): Promise<void> => {
        for (let i = 0; i < 10; i++) {
          if (!(await pagerEnabled(REGISTRY_SELECTORS.myPagePrevButton))) break;
          await page.click(REGISTRY_SELECTORS.myPagePrevButton);
          await sleep(800);
        }
      };
      // (撤去 2026-08-18) verifyPendingView は旧マイページ課金前段専用(消費者消滅)。
      // ---- 課金前ゾーン(④: 対象行の特定と確定) ----      // ---- 課金前ゾーン(④: 対象行の特定と確定) ----
      try {
        // ⚠**0件は1回だけ検索し直す**(2026-08-17 実測)。同一条件で無料検索が
        // 0件→1件→1件と揺れる(サイト側の一過性)ことを確認した。無料検索は
        // 人がもう一度押して吸収しているが、こちらの内部検索は再試行が無く
        // 0件を引いた瞬間に not_found で終わっていた(同日2回連続)。
        // 再試行はダイアログを閉じて開き直し、**種別と範囲の両端まで**入れ直す
        // (開き直しで条件が空に戻るため。片方でも欠けると必ず0件)。
        let zeroRetried = false;
        let retryWaitMs = DIALOG_RESULT_TIMEOUT_MS;
        let carriedProbe = true;
        for (;;) {
          try {
            await page.waitForSelector(REGISTRY_SELECTORS.dialogResultCheckbox, {
              state: "attached",
              timeout: retryWaitMs,
            });
            break; // 候補行が出た
          } catch (waitErr) {
            if (!isTimeoutError(waitErr)) throw waitErr;
            const loaded = await page.evaluate((sel) => {
              const t = document.querySelector(sel);
              return !!t && !/データ取得中/.test(t.textContent ?? "");
            }, REGISTRY_SELECTORS.dialogResultTable);
            if (!loaded) throw new RegistryFetchError("timeout");
            // ⚠計画は**最初の0件で1回だけ**立て、診断の予約(probe)を2回目へ持ち越す
            // (@codex #386 R2 P2)。2回目の時点で再計画すると、予約して残した margin
            // ちょうどの残量が「診断の余裕なし」と判定され、**診断のために取って
            // おいた予算で診断が打てない**という自己矛盾になる。
            const plan = resolveZeroRetryPlan(
              paidDeadline === null ? null : paidDeadline - Date.now(),
            );
            if (!zeroRetried && plan.retry) {
              zeroRetried = true;
              reportLive(
                "候補が0件でした。サイト側で一時的に0件になることがあるため、もう一度だけ検索し直します(まだ課金されていません)",
              );
              console.warn(
                "[registry-fetch] dialog returned 0 rows; retrying once (not charged)",
              );
              await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
              await sleep(ZERO_RETRY_SLEEP_MS);
              await page.click(REGISTRY_SELECTORS.dialogChibanKaokuListButton);
              await page.click(REGISTRY_SELECTORS.dialogChibanTypeNumeric);
              await page.fill(REGISTRY_SELECTORS.dialogChibanRangeStart, targetKey);
              await page.fill(REGISTRY_SELECTORS.dialogChibanRangeEnd, targetKey);
              // ⚠2回目の待ちは**検索を打つ前に**確定する(@codex #386 R3/R7)。
              // 計画には開き直しのブラウザ操作コストが載っていない(サイトの応答
              // 次第で事前に見積もれない)ため、操作が終わったいまの実測残量から
              // 診断の予約を守って再計算する。フル15秒のまま待つと外側予算を
              // 超えて timeout に化け、逆に最低値(3秒)を割る待ちでは非同期ロード
              // が終わらず**見かけだけの再試行**になる=検索せず断念して、1回目の
              // 0件の観測に基づき診断→not_found へ進む。
              const retryWait = resolveRetryWaitAfterSetup(
                plan.waitMs,
                paidDeadline === null ? null : paidDeadline - Date.now(),
                plan.probe,
              );
              carriedProbe = plan.probe;
              if (retryWait.proceed) {
                await page.click(REGISTRY_SELECTORS.dialogSearch);
                retryWaitMs = retryWait.waitMs;
                continue;
              }
              reportLive(
                "開き直しに時間がかかったため、検索し直しを断念しました(まだ課金されていません)",
              );
              console.warn(
                "[registry-fetch] zero-retry abandoned: setup consumed the wait budget (not charged)",
              );
              // ↓そのまま下の分類(診断→キャンセル→not_found)へ落ちる。
            }
            // 再試行の余裕なし or 2回目も0件。**画面の間取りを持ち帰ってから**
            // 課金せず not_found(診断より先に閉じると画面が消えるので順序厳守)。
            // 予算が診断ぶんも無いときは診断を諦めて即分類(timeout に化けるより良い)。
            // 2回目の0件では**持ち越した予約**で判定(再計画しない)。1回目で
            // 再試行の余裕が無かった場合はその場の plan.probe で判定。
            // ⚠ただし予約は「計画時点の余裕」しか保証しない(@codex R4)。開き直しの
            // 操作が margin に食い込んでいたら、実測残量で診断の内部予算を切り詰め、
            // それすら入らなければ諦める(診断で外側 timeout を踏んだら本末転倒)。
            const probePlan = resolveSecondZeroProbe(
              zeroRetried ? carriedProbe : plan.probe,
              paidDeadline === null ? null : paidDeadline - Date.now(),
            );
            if (probePlan.probe) {
              await logRegistryPageProbe(
                page,
                "paid-dialog-zero",
                probePlan.budgetMs ?? undefined,
              );
            }
            // ⚠後始末のキャンセルも**期限内に見切る**(@codex R5)。診断が予算切れに
            // なる原因が「レンダラ無応答」だった場合、このキャンセル(page.evaluate)も
            // 同じ理由で固まり、not_found の宣言に到達できない(外側 timeout が先に
            // 切れて 0件の事実が消える)。キャンセルは元々 best-effort(.catch で握る)
            // ので撃ちっぱなしで試み、**待ってよい時間だけ**待つ。固定500msだと
            // 残量500ms未満(診断を打たない僅少経路)で外側タイマーに負けるため、
            // 実測残量から headroom を守って切り詰める(0=待たずに投げる・@codex R8)。
            // page の後始末は provider の finally(close)がやる。
            const cancelAttempt = domClick(REGISTRY_SELECTORS.dialogCancel).catch(
              () => {},
            );
            const cleanupBoundMs = resolveCleanupBound(
              paidDeadline === null ? null : paidDeadline - Date.now(),
            );
            if (cleanupBoundMs > 0) {
              await Promise.race([cancelAttempt, sleep(cleanupBoundMs)]);
            }
            throw new RegistryFetchError("not_found");
          }
        }
        // 対象の地番セルを探して check(複数ページは searchByLocation と同じ防御で送る)。
        let found = false;
        for (let pageNo = 0; pageNo < MAX_DIALOG_PAGES; pageNo++) {
          const result = (await page.evaluate(
            (json) => {
              const { tableSel, target } = JSON.parse(json) as {
                tableSel: string;
                target: string;
              };
              // normalizeChibanForDialog と同じ規則(browser 内で自己完結させるため複製)。
              const norm = (s: string) =>
                s
                  .normalize("NFKC")
                  .replace(/[‐‑‒–—―ー−]/g, "-")
                  .replace(/番地/g, "-")
                  .replace(/[番号の]/g, "-")
                  .replace(/\s+/g, "")
                  .replace(/-+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .toLowerCase();
              const t = document.querySelector(tableSel);
              if (!t) return "no-table";
              const cells = Array.from(t.querySelectorAll('td[id^="cbnDlgChibanDt_"]'));
              for (const cell of cells) {
                if (norm(cell.textContent ?? "") === target) {
                  const row = cell.closest("tr");
                  const cb = row?.querySelector(
                    'input[type="checkbox"]',
                  ) as HTMLInputElement | null;
                  if (!cb) return "no-checkbox";
                  if (!cb.checked) cb.click();
                  return "checked";
                }
              }
              return "not-found";
            },
            JSON.stringify({
              tableSel: REGISTRY_SELECTORS.dialogResultTable,
              target: targetKey,
            }),
          )) as string;
          if (result === "checked") {
            found = true;
            break;
          }
          if (result !== "not-found") break; // no-table / no-checkbox = 想定外DOM → 中止
          // 次ページへ(無ければ終了)。searchByLocation と同じ「内容が変わるまで」待ち。
          const hasNext = await page.evaluate((sel) => {
            const b = document.querySelector(sel) as { disabled?: boolean } | null;
            if (!b || b.disabled) return false;
            const style = getComputedStyle(b as unknown as Element);
            return style.display !== "none" && style.visibility !== "hidden";
          }, REGISTRY_SELECTORS.dialogPageNext);
          if (!hasNext) break;
          const prevFirst = (await page.evaluate((sel) => {
            const c = document.querySelector(sel)?.querySelector('td[id^="cbnDlgChibanDt_"]');
            return (c?.textContent ?? "").trim();
          }, REGISTRY_SELECTORS.dialogResultTable)) as string;
          await page.click(REGISTRY_SELECTORS.dialogPageNext);
          await page.waitForFunction(
            (arg) => {
              const { tableSel, prevRef } = arg as {
                tableSel: string;
                prevRef: string;
              };
              const t = document.querySelector(tableSel);
              if (!t) return false;
              if (/データ取得中/.test(t.textContent ?? "")) return false;
              const firstCell = t.querySelector('td[id^="cbnDlgChibanDt_"]');
              const val = (firstCell?.textContent ?? "").trim();
              return val !== "" && val !== prevRef;
            },
            {
              tableSel: REGISTRY_SELECTORS.dialogResultTable,
              prevRef: prevFirst,
            },
            { timeout: DIALOG_RESULT_TIMEOUT_MS },
          );
        }
        if (!found) {
          // 検索時に選んだ地番が今は見つからない → 課金せず終了(候補の再検索を促す)。
          await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
          throw new RegistryFetchError("not_found");
        }
        // ⚠**チェックが効いたかを実測してから確定を押す**(発注者指示 2026-08-15:
        //   「検索結果の地番が物件と同一ならチェックボックスにチェックを入れて確定
        //   ボタンを押すようにしてください」)。従来は cb.click() を発行するだけで、
        //   サイト側の選択簿記(選択済み欄)に載ったかを**見ずに**確定へ進んでいた。
        //   登録されていなければ確定はグレーの no-op → 後段のマイページ待ちで
        //   timeout(実課金テスト 2026-08-15 の2回連続失敗と同じ形)。
        //   判定はサイト自身の簿記(#cbnDlgCheckedChibanString / ...Dsp)で行う。
        //   checkbox.checked は cb.click() 自体が立ててしまうので証拠にならない。
        //   ⚠**非空では足りない**(@codex #380 R6 P2): 古い選択が簿記に残っていると
        //   非空判定は素通りし、**意図しない筆**を確定→請求してしまう。簿記の中身を
        //   同じ正規化(check ループと同一の norm)で **targetKey と厳密一致**させる。
        //   複数選択が載っている場合も結合文字列は一致しない=中止(複数課金の防止)。
        const selVerifyJson = (await page.evaluate(
          (json) => {
            const { stringSel, dspSel, okSel, target } = JSON.parse(json) as {
              stringSel: string;
              dspSel: string;
              okSel: string;
              target: string;
            };
            // normalizeChibanForDialog と同じ規則(browser 内で自己完結させるため複製)。
            const norm = (s: string) =>
              s
                .normalize("NFKC")
                .replace(/[‐‑‒–—―ー−]/g, "-")
                .replace(/番地/g, "-")
                .replace(/[番号の]/g, "-")
                .replace(/\s+/g, "")
                .replace(/-+/g, "-")
                .replace(/^-+|-+$/g, "")
                .toLowerCase();
            const readVal = (sel: string): string => {
              const el = document.querySelector(sel);
              if (!el) return "";
              const v = (el as { value?: unknown }).value;
              const s = typeof v === "string" && v.length > 0 ? v : (el.textContent ?? "");
              return s.trim();
            };
            const ok = document.querySelector(okSel) as { disabled?: boolean } | null;
            return JSON.stringify({
              registered: norm(readVal(stringSel)) === target || norm(readVal(dspSel)) === target,
              // disabled 属性が無い作り(class で灰色化)なら false のまま=閉じ確認が拾う。
              okDisabled: !ok || ok.disabled === true,
            });
          },
          JSON.stringify({
            probe: "verify-chiban-selection",
            stringSel: REGISTRY_SELECTORS.dialogSelectedString,
            dspSel: REGISTRY_SELECTORS.dialogSelectedDisplay,
            okSel: REGISTRY_SELECTORS.dialogOk,
            target: targetKey,
          }),
        )) as string;
        const selVerify = JSON.parse(selVerifyJson) as {
          registered: boolean;
          okDisabled: boolean;
        };
        if (!selVerify.registered || selVerify.okDisabled) {
          console.warn(
            "[registry-fetch] candidate selection did not register as the requested parcel; refusing before confirm (not charged)",
          );
          reportLive("⚠選択が対象の地番として反映されませんでした。課金せず中止します");
          await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
          throw new RegistryFetchError("provider_error");
        }
        abortIfCancelledPaid();
        reportLive("対象の地番を選択しました。確定します(まだ課金されていません)");
        await domClick(REGISTRY_SELECTORS.dialogOk);
        // ⚠**閉じたことを実測する**。従来の sleep だけだと、確定が効いていなくても
        //   素通りして後段で分かりにくく死ぬ。⚠ダイアログは「隠すだけ」の閉じ方にも
        //   備える(#368 の教訓)＝getClientRects()===0(祖先の display:none を含めて
        //   不可視)か visibility:hidden を「閉じた」とみなす。
        try {
          await page.waitForFunction(
            (arg) => {
              const { sel } = arg as { probe: string; sel: string };
              const d = document.querySelector(sel);
              if (!d) return true;
              if (d.getClientRects().length === 0) return true;
              return getComputedStyle(d).visibility === "hidden";
            },
            { probe: "chiban-dialog-closed", sel: REGISTRY_SELECTORS.dialogRoot },
            { timeout: DIALOG_RESULT_TIMEOUT_MS },
          );
        } catch (closeErr) {
          if (!isTimeoutError(closeErr)) throw closeErr;
          console.warn(
            "[registry-fetch] chiban dialog did not close after OK; refusing before confirm (not charged)",
          );
          reportLive("⚠確定を押しましたがダイアログが閉じません。課金せず中止します");
          throw new RegistryFetchError("provider_error");
        }
        reportLive("地番を確定しました(まだ課金されていません)");
        await sleep(1000); // 確定値のフォーム反映を待つ

        abortIfCancelledPaid();
        reportLive("請求する書類の種類を選択しています(まだ課金されていません)");
        // ---- ⑤ 請求事項=**選んだ種別のみ**(検証つき・課金前) ----
        // 所有者事項(既定)/全部事項 のどちらか一方だけをONにし、残りは全部OFF。
        // 外し漏れ=追加課金なので、操作後に checked を読み戻して検証する。
        // disabled があり得る(#fuHeisaTokibo)ため DOM click で操作する。
        // ⚠on と off は種別から純関数(certificateCheckboxPlan)で導く=サイト初期状態の
        // 全部事項ONを、選んだ種別へ確実に反転させる。
        const certPlan = certificateCheckboxPlan(input.certificateType);
        const certJson = (await page.evaluate(
          (json) => {
            const { onSel, offSels } = JSON.parse(json) as {
              onSel: string;
              offSels: string[];
            };
            const set = (sel: string, want: boolean): string => {
              const el = document.querySelector(sel) as HTMLInputElement | null;
              if (!el) return want ? "missing" : "absent-ok";
              if (el.checked !== want) el.click();
              return el.checked === want ? "ok" : "failed";
            };
            const on = set(onSel, true);
            const offResults = offSels.map((sel) => set(sel, false));
            return JSON.stringify({ on, offResults });
          },
          JSON.stringify({
            onSel: certPlan.on,
            offSels: certPlan.off,
          }),
        )) as string;
        const cert = JSON.parse(certJson) as {
          on: string;
          offResults: string[];
        };
        if (cert.on !== "ok" || cert.offResults.some((r) => r !== "ok" && r !== "absent-ok")) {
          // 種別を意図どおりに揃えられない → 課金前に中止(余計なものを買わない)。
          throw new RegistryFetchError("provider_error");
        }

        // ---- ⑥(撤去 2026-08-18) マイページの基準控え(行IDのdiff)は使わない ----
        // 発注者指示「マイページに登録はせずに直接請求します」で、課金対象の選択は
        // **請求リスト側の行照合(地番+所在+種別+未請求の全一致+read-back)**に一本化。
        // 旧基準(未請求絞込×単一ページ×全行ID)は「マイページで選んだ行に課金する」
        // 旧経路の作成同一性のための装置で、消費者が消えた。残すと行が溜まった
        // 実運用で「単一ページでない」誤中止だけを生む。課金後の行特定は
        // 「請求済フィルタ×地番一致×最新日時×期限実測」(下のループの従来
        // フォールバック)が担う。

        abortIfCancelledPaid();
        reportLive("請求条件を確定しています(まだ課金されていません)");
        // ⚠**確定のクリックそのものから診断の内側にする**(@codex #383 P2×3)。
        // 守る範囲を3回にわたって1段ずつ手前へ動かした
        //   ①最後の一覧待ちだけ → ②タブのクリックも → ③確定直後の待ちも → ④確定クリックも
        // 理由はどれも同じ: **その一手前で転ぶと診断がまったく走らない**。
        // 確定を押した瞬間にページが遷移して実行コンテキストが壊れると domClick 自体が
        // reject するため、クリックも内側でなければ「確定の後どこに着いたか」を採れない。
        //
        // ⇒ **境界は「確定を押す直前」で確定**。ここから先は
        //   ①確定のクリック ②遷移先の待ち(請求リスト or マイページ)
        //   ③マイページタブのクリック ④マイページ一覧の待ち
        // のどれで転んでも、同じ診断（その瞬間の画面構造）を採ってから投げ直す。
        // ⚠ここより手前（請求事項の選択など）は意図的に RegistryFetchError を投げる
        // 自前の検査なので、画面構造の診断は要らない（採ると雑音になる）。
        // ⚠確定を押すと所在欄(#fuChibanKuiki)ごと画面が消えるため、行照合に使う
        // 所在は**押す前に**読んで持っておく。⚠この欄は**市区町村以下だけ**
        // (都道府県は #fuTodofukenShozai の select に分離)なので、行 hidden
        // (都道府県から始まる完全形・probe13実測)と比べる期待値は、住所から
        // 同じ純関数で導いた都道府県を連結して組み立てる(@codex #389 R1 P1)。
        const { prefecture: prefectureForPick } = splitAddressForLocationSearch(
          input.address,
        );
        const kuikiForPick = (await page.evaluate(
          (json) => {
            const { sel } = JSON.parse(json) as { sel: string };
            const el = document.querySelector(sel) as HTMLInputElement | null;
            return el?.value ?? "";
          },
          JSON.stringify({
            probe: "kuiki-value",
            sel: REGISTRY_SELECTORS.locationSearchAddress,
          }),
        )) as string;
        // ---- 課金前の基準: 既存行の受付番号を控える(@codex #390 R2 P1) ----
        // 「いま課金した行」の証明には**新規性**が要る。可視の中の最新だけでは、
        // 新行が非同期でまだ表に出ていない間に同じ筆の古い請求済行を掴む。
        // この画面(不動産請求タブ)には #myPageTable が同居しているので、確定を
        // 押す前に全ページの受付番号を控え、課金後は**基準に無い行**だけから同定する。
        // ⚠読み切れなければ課金前に中止(不完全な基準は古い行を「新規」に化けさせる)。
        {
          // 1回分の全ページ走査。ok=false は「この読みを基準に使えない」
          // (読み込み中/空ID混入/10ページ超)。
          const collectBaselineOnce = async (): Promise<{
            ok: boolean;
            ids: Set<string>;
          }> => {
            const ids = new Set<string>();
            await resetMyPageToFirst();
            for (let pageNo = 0; ; pageNo++) {
              if (pageNo >= 10) return { ok: false, ids }; // 完全性を保証できない
              const scanJson = (await page.evaluate(
                (json) => {
                  const { tableSel } = JSON.parse(json) as { tableSel: string };
                  const t = document.querySelector(tableSel);
                  if (!t || /データ取得中/.test(t.textContent ?? "")) {
                    return JSON.stringify({ loading: true, rows: [] });
                  }
                  const rows: string[][] = [];
                  for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
                    const tds = tr.querySelectorAll("td");
                    if (tds.length < 7) continue;
                    // ⚠**解釈はNode側の純関数(parseMyPageRowCells)に集約**。
                    // ここは列の生データを返すだけ(@codex #393 R1)。
                    const cellHtmls = Array.from(tds)
                      .slice(0, 12)
                      .map((td) => (td as HTMLElement).innerHTML ?? "");
                    rows.push(cellHtmls);
                  }
                  return JSON.stringify({ loading: false, rows });
                },
                JSON.stringify({
                  probe: "mypage-scan",
                  tableSel: REGISTRY_SELECTORS.myPageTable,
                }),
              )) as string;
              const scan = JSON.parse(scanJson) as {
                loading: boolean;
                rows: string[][];
              };
              if (scan.loading) return { ok: false, ids };
              // ⚠基準は**全行のIDが読めた時だけ**成立(@codex #345 R4 P1の復元・
              // #390 R3)。空IDの行を黙って飛ばすと、その行が課金後にIDを得て
              // 「基準に無い行=新規」に化け、古いPDFを掴む。
              // ⚠基準の成立規則は純関数に集約(未請求行は受付番号を持たないのが正常)。
              const parsedRows = scan.rows
                .map((cells) => parseMyPageRowCells(cells))
                .filter((r): r is MyPageScanRow => r !== null);
              const built = collectBaselineReceiptNos(parsedRows);
              if (!built.ok) return { ok: false, ids };
              for (const id of built.receiptNos) ids.add(id);
              if (!(await myPageHasNext())) break;
              await page.click(REGISTRY_SELECTORS.myPageNextButton);
              await sleep(1200);
            }
            return { ok: true, ids };
          };
          let baselineOk = false;
          for (let attempt = 0; attempt < 3 && !baselineOk; attempt++) {
            if (attempt > 0) await sleep(1500);
            baselineTrIds.clear();
            // ⚠基準は**全履歴**から(@codex #390 R4 P1)。select に前回の
            // 「未請求」等が残っていると、隠れていた古い購入が基準から漏れ、
            // 課金後(すべて表示)に「新規」へ化ける。適用+実測検証を通った回だけ
            // を基準として採用する。
            const changed = await applyMyPageFilter("すべて");
            if (!(await verifyAllFilter())) continue;
            // ⚠select の値は同期・**表の再描画は非同期**(@codex #390 R6 P1)。
            // いま change を発火した直後なら、旧フィルタのままの表を読んで
            // 「完全な基準」と誤認し得る。猶予を置いたうえで**二重読み**し、
            // 受付番号の集合が完全一致した読みだけを基準として採用する
            // (再描画が途中で挟まれば集合がずれ、この回は捨てられる)。
            if (changed) await sleep(2000);
            const first = await collectBaselineOnce();
            if (!first.ok) continue;
            await sleep(800);
            if (!(await verifyAllFilter())) continue;
            const second = await collectBaselineOnce();
            if (!second.ok) continue;
            if (
              first.ids.size !== second.ids.size ||
              [...first.ids].some((id) => !second.ids.has(id))
            ) {
              continue; // 読みの間に描画が動いた=安定していない
            }
            for (const id of second.ids) baselineTrIds.add(id);
            baselineOk = true;
          }
          if (!baselineOk) {
            console.warn(
              "[registry-fetch] my-page baseline unreadable; refusing before confirm (not charged)",
            );
            throw new RegistryFetchError("provider_error");
          }
        }
        try {
          await domClick(REGISTRY_SELECTORS.requestConfirmButton);
          // ⚠確定(fuBtnForward)の着地は**請求リスト(/reqf/fudosan-list)**
          // (2026-08-17 probe13で実測確定。マイページではない。selectTab('tabMy')
          // のタブもこのページには存在しない=第1回・第5回のテストが止まった原因)。
          await page.waitForSelector(REGISTRY_SELECTORS.searchResult, {
            state: "attached",
            timeout: DIALOG_RESULT_TIMEOUT_MS,
          });
          abortIfCancelledPaid();
          reportLive("請求リストで対象の行を選んでいます(まだ課金されていません)");
          // 行の照合材料は各行の hidden(#chiban_N/#chibanKuiki_N/#seikyuType_N/
          // #seikyuzumi_N)。⚠**check した行がそのまま請求対象**=お金の一歩手前
          // なので、地番+所在+種別+未請求の全一致だけを選ぶ(過去テストの未請求が
          // 同じカートに累積し得る。同一内容の重複は同じ商品=先頭の1件を使う)。
          const listRowsJson = (await page.evaluate(
            (json) => {
              const { prefix, checkboxSel } = JSON.parse(json) as {
                prefix: Record<string, string>;
                checkboxSel: string;
              };
              const rows: Array<Record<string, unknown>> = [];
              const boxes = Array.from(
                document.querySelectorAll(checkboxSel),
              ) as HTMLInputElement[];
              for (const box of boxes) {
                const m = box.id.match(/_(\d+)$/);
                if (!m) continue;
                const n = m[1];
                const read = (p: string): string => {
                  const el = document.getElementById(`${p}${n}`) as
                    | HTMLInputElement
                    | null;
                  return el?.value ?? "";
                };
                // 種別(土地/建物)は hidden に無く、行の可視セル td[3] が持つ
                // (probe13 実測・@codex #390 R5: 同番号の土地と建物の取り違え防止)。
                const tr = box.closest("tr");
                const kindCell = tr
                  ? (tr.querySelectorAll("td")[3]?.textContent ?? "")
                  : "";
                rows.push({
                  index: Number(n),
                  chiban: read(prefix.chiban),
                  kuiki: read(prefix.kuiki),
                  seikyuType: read(prefix.seikyuType),
                  seikyuzumi: read(prefix.seikyuzumi),
                  checked: box.checked === true,
                  kind: kindCell.trim(),
                });
              }
              return JSON.stringify(rows);
            },
            JSON.stringify({
              probe: "fudosan-list-rows",
              prefix: FUDOSAN_LIST_HIDDEN_PREFIX,
              checkboxSel: REGISTRY_SELECTORS.fudosanListRowCheckbox,
            }),
          )) as string;
          const listRows = JSON.parse(listRowsJson) as FudosanListRow[];
          // ⚠期待値は**都道府県を連結して**組み立てる(@codex #389 R1 P1)。
          // 素の #fuChibanKuiki 値(市区町村以下)と行 hidden(都道府県込みの完全形)
          // の厳密比較だと全件 no-match になり、確定後に必ず中止してしまう。
          // (課金後の行同定 pickChargedMyPageRow も同じ期待所在を使う)
          expectedKuiki = kuikiForPick.trim()
            ? `${prefectureForPick ?? ""}${kuikiForPick}`
            : kuikiForPick;
          const pick = selectFudosanListRow(listRows, {
            targetKey,
            kuiki: expectedKuiki,
            seikyuTypeLabel:
              input.certificateType === "all" ? "全部事項" : "所有者事項",
            // 家屋番号での請求=建物/地番での請求=土地(@codex #390 R5)。
            kindLabel: isBuilding ? "建物" : "土地",
          });
          if (!pick.ok) {
            // 迷ったら選ばない(課金前中止・カートに未請求が残るだけで無害)。
            reportLive(
              "請求リストで対象の行を特定できませんでした(課金していません)",
            );
            console.warn(
              `[registry-fetch] fudosan-list row pick failed (${pick.reason}); refusing (not charged)`,
            );
            throw new RegistryFetchError("provider_error");
          }
          if (pick.duplicateCount > 0) {
            // 過去のテストで積まれた同一内容の未請求が残っている状態。同じ商品なので
            // 先頭の1件を使う(害はないが、状況として journal に残す)。
            console.warn(
              `[registry-fetch] fudosan-list has ${pick.duplicateCount} duplicate pending row(s); using the first (not charged yet)`,
            );
          }
          // 対象行だけを check し、それ以外は必ず外す(2件 check=二重課金の入口)。
          // checkbox は onclick=chkSentaku(this) を持つため、状態を変えるときは
          // click で site 側の簿記も発火させる。
          await page.evaluate(
            (json) => {
              const { checkboxSel, targetIndex } = JSON.parse(json) as {
                checkboxSel: string;
                targetIndex: number;
              };
              const boxes = Array.from(
                document.querySelectorAll(checkboxSel),
              ) as HTMLInputElement[];
              for (const box of boxes) {
                const m = box.id.match(/_(\d+)$/);
                if (!m) continue;
                const want = Number(m[1]) === targetIndex;
                if (box.checked !== want) box.click();
              }
            },
            JSON.stringify({
              probe: "fudosan-list-apply",
              checkboxSel: REGISTRY_SELECTORS.fudosanListRowCheckbox,
              targetIndex: pick.index,
            }),
          );
          // ⚠押した「つもり」で進まない(@codex #380 R5/R6 と同じ型)。read-back で
          // 「ちょうど対象の1件だけが check されている」ことを実測してから登録へ。
          const checkedStateJson = (await page.evaluate(
            (json) => {
              const { checkboxSel } = JSON.parse(json) as {
                checkboxSel: string;
              };
              const boxes = Array.from(
                document.querySelectorAll(checkboxSel),
              ) as HTMLInputElement[];
              const checked: number[] = [];
              for (const box of boxes) {
                const m = box.id.match(/_(\d+)$/);
                if (m && box.checked === true) checked.push(Number(m[1]));
              }
              return JSON.stringify(checked);
            },
            JSON.stringify({
              probe: "fudosan-list-checked",
              checkboxSel: REGISTRY_SELECTORS.fudosanListRowCheckbox,
            }),
          )) as string;
          const checkedIndexes = JSON.parse(checkedStateJson) as number[];
          pickedRowIndex = pick.index;
          if (checkedIndexes.length !== 1 || checkedIndexes[0] !== pick.index) {
            reportLive(
              "請求リストの選択を確認できませんでした(課金していません)",
            );
            console.warn(
              "[registry-fetch] fudosan-list check verification failed; refusing (not charged)",
            );
            throw new RegistryFetchError("provider_error");
          }
          // 選択の実測まで完了。⚠ここで try を閉じる=診断(page-probe)の守備範囲は
          // **課金前まで**(この先の請求クリック以降で診断を採ると分類が濁る)。
        } catch (transitionErr) {
          // ⚠**第1回・第5回の立ち会いテストが実際に止まった区間**(課金ゼロ)。probe13 で
          // 正しい遷移(行check→直接請求)を実測して直したが、次に想定外の画面が
          // 出たときも**この瞬間の画面構造だけ**を記録して持ち帰る(表の中身は読まない=
          // page-probe の契約)。
          //
          // ⚠変数名を `err` にしない。この catch は**診断を足してそのまま投げ直すだけ**で、
          // 失敗を provider_error へ**変換しない**。`catch (err)` だと「provider_error へ
          // 変換する catch は RegistryFetchError を素通しせよ」という既存の走査ガード
          // (shozai-dialog.test.ts)の網に紛れ込み、意味の違う要求で縛られる。
          await logRegistryPageProbe(page, "mypage-transition");
          throw transitionErr;
        }
        // (撤去 2026-08-18) 旧: マイページで未請求に絞って対象行を選び直してから
        // 請求していた。直接請求では選択は請求リスト側で完了済み。
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        console.warn(
          "[registry-fetch] paid flow pre-charge failed (not charged):",
          summarizeRegistrySearchError(err),
        );
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
        throw new RegistryFetchError("provider_error");
      }

      // ⚠実況はこの位置(=aborted確認より前)で刻む。下の確認〜charged代入の
      // 「同一同期区間」に await を挟まないため(reportLive は同期・撮影は void)。
      // ⚠**ここが最後の分かれ目**。以降は中止を見る場所が無いので、受付を閉じてから
      //   課金に入る(閉じ忘れると「中止しています…」と出したまま請求が進み、
      //   **止めたつもりなのに請求される**)。
      //   ⚠閉じる**前**に最後の確認をする(閉じた後に押された中止はもう効かない)。
      abortIfCancelledPaid();
      input.live?.endCancelable?.();
      reportLive("これ以降は中止できません(請求の手続きに入ります)");
      reportLive("⚠ここから請求(課金)を実行します");
      // ⚠中止の印を**請求ボタンの直前**で確認(@codex R10 P1)。provider が課金前
      // タイムアウトで reject した後も、この関数は裏で走り続けている可能性がある。
      // ここで確認せず押すと、呼び出し側は timeout(=台帳なし・ロック解除済み)として
      // 処理を終えているのに課金だけが起きる=**記録なき課金**。
      // この確認〜下の charged 代入は同一同期区間(間に await なし)=競合の隙間なし。
      // ⚠課金後 try の**外**で確認する(まだ課金していない失敗を charged_but_failed に
      // 分類しないため)。
      if (input.chargeState?.aborted) {
        throw new RegistryFetchError("provider_error");
      }

      // ---- ⑧ 請求。⚠**課金の瞬間は「確認ダイアログのＯＫ」**(2026-08-19 実測) ----
      // 【請求】(#btn_seikyu)は押しても submit されず、金額入りの確認ダイアログ
      // (jQuery UI modal・既定ラベル「ＯＫ/キャンセル」)を出すだけ。第7回テストは
      // ここでＯＫを押さずに画面遷移を待ち、課金ゼロのまま timeout していた。
      // ⇒ ①合計金額の裏取り(課金前) ②請求クリック(無料) ③ダイアログ待ち
      //    ④本文の金額照合 ⑤**ＯＫ直前で charged=true** ⑥ＯＫ押下(=課金)。
      let confirmedAmountYen = 0;
      {
        // 選択行の料金と、サイトが計算した請求金額合計が**一致**することを実測する。
        // 一致=「いま選ばれているのは対象の1件だけ」をサイトの数字で裏取りしたのと同じ
        // (選択が増えていれば合計が跳ね上がる)。読めなければ課金前に中止(fail-closed)。
        const amountsJson = (await page.evaluate(
          (json) => {
            const { feeId, totalSel } = JSON.parse(json) as {
              feeId: string;
              totalSel: string;
            };
            const fee = document.getElementById(feeId) as HTMLInputElement | null;
            const total = document.querySelector(totalSel);
            return JSON.stringify({
              rowFeeText: fee?.value ?? "",
              totalText: (total?.textContent ?? "").trim(),
            });
          },
          JSON.stringify({
            probe: "seikyu-amounts",
            feeId: `${FUDOSAN_LIST_HIDDEN_PREFIX.ryokin}${pickedRowIndex}`,
            totalSel: REGISTRY_SELECTORS.seikyuTotalAmount,
          }),
        )) as string;
        const amounts = JSON.parse(amountsJson) as {
          rowFeeText: string;
          totalText: string;
        };
        const decision = resolveSeikyuConfirm(amounts);
        if (!decision.proceed) {
          reportLive(`請求金額を確認できませんでした(課金していません): ${decision.detail}`);
          console.warn(
            `[registry-fetch] seikyu amount gate failed (${decision.reason}); refusing (not charged)`,
          );
          throw new RegistryFetchError("provider_error");
        }
        confirmedAmountYen = decision.amountYen;
        reportLive(
          `請求金額の合計が${confirmedAmountYen}円(対象1件)であることを確認しました(まだ課金されていません)`,
        );
      }
      // 【請求】のクリック自体は**無料**(確認ダイアログを出すだけ)。
      await domClick(REGISTRY_SELECTORS.fudosanListSeikyuButton).catch(() => {});
      // 確認ダイアログの出現を待ち、本文の金額を最終照合する(まだ課金していない)。
      let confirmButtonIndex = -1;
      {
        const deadline = Date.now() + DIALOG_RESULT_TIMEOUT_MS;
        for (;;) {
          const dlgJson = (await page.evaluate(
            (_json) => {
              const panes = Array.from(
                document.querySelectorAll(".ui-dialog"),
              ).filter((d) => (d as HTMLElement).offsetParent !== null);
              if (panes.length === 0) return JSON.stringify({ open: false });
              const pane = panes[panes.length - 1];
              const buttons = Array.from(
                pane.querySelectorAll(".ui-dialog-buttonpane button"),
              ).map((b) => (b.textContent ?? "").trim());
              const content = pane.querySelector(".ui-dialog-content");
              return JSON.stringify({
                open: buttons.length > 0,
                buttons,
                text: (content?.textContent ?? "").trim().slice(0, 400),
              });
            },
            JSON.stringify({ probe: "seikyu-dialog" }),
          )) as string;
          const dlg = JSON.parse(dlgJson) as {
            open: boolean;
            buttons?: string[];
            text?: string;
          };
          if (dlg.open && dlg.buttons) {
            const match = dialogAmountMatches(dlg.text ?? "", confirmedAmountYen);
            if (!match.ok) {
              reportLive(
                `確認画面の金額(${match.found ?? "不明"}円)が想定(${confirmedAmountYen}円)と違うため中止しました(課金していません)`,
              );
              console.warn(
                "[registry-fetch] seikyu dialog amount mismatch; refusing (not charged)",
              );
              throw new RegistryFetchError("provider_error");
            }
            confirmButtonIndex = pickConfirmButtonIndex(dlg.buttons);
            break;
          }
          if (Date.now() >= deadline) {
            reportLive("請求の確認画面が出ませんでした(課金していません)");
            console.warn(
              "[registry-fetch] seikyu confirm dialog did not appear; refusing (not charged)",
            );
            throw new RegistryFetchError("provider_error");
          }
          await sleep(500);
        }
        if (confirmButtonIndex < 0) {
          // 押してよいボタンが分からない=押さない(取り消し側を誤って押すより安全)。
          reportLive("請求の確認画面のボタンを判別できませんでした(課金していません)");
          console.warn(
            "[registry-fetch] seikyu confirm button not identified; refusing (not charged)",
          );
          throw new RegistryFetchError("provider_error");
        }
      }
      // ⚠中止の印は**ＯＫを押す直前**で最終確認(ここまで課金していない)。
      if (input.chargeState?.aborted) {
        throw new RegistryFetchError("provider_error");
      }
      try {
        // ⚠課金境界フラグ(@codex #345 P1)。**ＯＫを押す直前**に立てる(第7回の
        // 誤判定=請求クリック時点で立てていたため、未課金なのに課金済み扱いになった)。
        if (input.chargeState) input.chargeState.charged = true;
        // ⚠ＯＫ押下で submit が走り、実行コンテキストが壊れて evaluate が reject し得る。
        // 課金は受理されている可能性があるため握り、**着地の実測**へ委ねる。
        await page
          .evaluate(
            (json) => {
              const { idx } = JSON.parse(json) as { idx: number };
              const panes = Array.from(
                document.querySelectorAll(".ui-dialog"),
              ).filter((d) => (d as HTMLElement).offsetParent !== null);
              const pane = panes[panes.length - 1];
              const buttons = Array.from(
                pane?.querySelectorAll(".ui-dialog-buttonpane button") ?? [],
              ) as HTMLButtonElement[];
              buttons[idx]?.click();
            },
            JSON.stringify({ probe: "seikyu-confirm-ok", idx: confirmButtonIndex }),
          )
          .catch(() => {});
        // 請求の submit で /reqf/fudosan-seikyu(マイページ一覧のある画面)へ遷移する
        // (probe13: form action で実測)。課金後なので中止せず、一覧の出現を待って
        // 「請求済」の実測(下のループ)へ。⚠診断(page-probe)は課金前のみの原則の
        // ため、ここで転んでも probe は採らず charged_but_failed に分類される。
        await page.waitForSelector(REGISTRY_SELECTORS.myPageTable, {
          state: "attached",
          timeout: DIALOG_RESULT_TIMEOUT_MS,
        });
        // ⚠ここではまだ「課金済み」と**断定しない**(@codex #380 R5 P2)。domClick は
        //   ボタンが不在/無効なら黙って何もしないため、受け付けられていないのに
        //   「課金済み」と実況すると、後で charged_but_failed になったとき利用者と
        //   診断の両方が誤る。断定は下で行が「請求済」と実測できてから。
        //   (chargeState.charged=true は**安全側の会計**なのでこの直前のまま維持=
        //    疑わしきは課金済み扱い。実況の文言だけを事実に合わせる。)
        reportLive("請求を実行しました。サイト側の反映を確認しています");
        // ⑨⑩ 課金した行が「請求済+PDF準備完了」になるのを待ってから選択して DL へ。
        // ⚠フィルタは**「すべて」**にする(@codex #390 R1 P1)。「請求済」に絞ると
        // 請求中のままの**いま買った行が隠れ**、同じ筆の古い請求済行が「見えている
        // 最新」になって古いPDFを掴む。すべて表示で走査し、準備状態は行の
        // status/expiry で判定する(「すべて」オプションは probe13 final2 で実測[確定])。
        // ⚠一覧はページ分割され得るため、行IDが見つからない時は次ページを最大10ページ
        // 探索する(@codex R5 P1)。課金後なので中止はせず、見つからなければ再試行→
        // 使い切ったら charged_but_failed(台帳は記録済み・マイページ確認を案内)。
        let ready = false;
        for (let attempt = 0; attempt < 20 && !ready; attempt++) {
          await sleep(3000);
          // ⚠各走査の前に「すべて」を適用+実測検証(@codex #390 R4 P1)。リロード等で
          // 絞り込みが戻ると走査が部分集合になり、新行が見えず charged_but_failed に
          // 化ける。検証できない回はこの attempt を捨てて次へ(課金後なので中止しない)。
          await applyMyPageFilter("すべて");
          if (!(await verifyAllFilter())) {
            await domClick(REGISTRY_SELECTORS.myPageReloadButton).catch(() => {});
            continue;
          }
          // ⚠実況の心拍(2026-08-15)。このループは最悪 20周×(3秒+最大10ページ走査)で
          //   3分を超えるが、実況ストアの保管期限(LIVE_VIEW_TTL_MS=3分)は**最終書き込み**
          //   から数える。無言のまま超えると、課金済みで一番不安な待ちの最中に
          //   パネルごと消える(steps/shots も削除=見返し不能)。5周ごとに固定文言を
          //   刻んで期限を更新する(最大3行の増加・非PII)。
          if (attempt > 0 && attempt % 5 === 0) {
            // ⚠ここも断定しない(まだ「請求済」を実測できていない)。
            reportLive("請求の反映を待っています…");
          }
          // ⚠各走査は**先頭ページから**(@codex R6 P1)。前回の走査で末尾ページに
          // 居座ったままだと、リロード後に先頭側へ入った行を以降ずっと見逃す。
          await resetMyPageToFirst();
          // ---- 同定フェーズ: 全ページを走査して行を集め、Node 側の純関数で
          // 「いま買った行」を1つに決める(提出前レビュー confidence82 対応)。
          // ⚠マイページは口座の**全物件の履歴**。旧実装の「地番末尾一致×最初に
          // 見つかったページの最新」では、**別の町の同一地番**の行(どこにでもある
          // 「1-1」等)を掴んで他人の筆のPDFを添付し得た。同定は
          // 所在の前半(地番区域・都道府県込み)+末尾の地番(境界つき)+全ページ中の
          // 受付日時最新、を pickChargedMyPageRow(単体テスト済み)で行う。
          // ⚠所在セルの値は PII: Node のメモリ内でのみ扱い、ログ・実況に出さない。
          // ⚠行の位置は**ページ番号+そのページ内の位置**で持つ(@codex #393 R2 P1)。
          // 全ページを平らに繋いだ通し番号をページ内の位置として渡すと、2ページ目
          // 以降で必ず外し、課金済みなのにPDFを取り逃す。
          const scannedRows: Array<
            MyPageScanRow & { pageNo: number; indexInPage: number }
          > = [];
          let scanLoading = false;
          for (let pageNo = 0; pageNo < 10; pageNo++) {
            const scanJson = (await page.evaluate(
              (json) => {
                const { tableSel } = JSON.parse(json) as { tableSel: string };
                const t = document.querySelector(tableSel);
                if (!t || /データ取得中/.test(t.textContent ?? "")) {
                  return JSON.stringify({ loading: true, rows: [] });
                }
                const rows: string[][] = [];
                for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
                  const tds = tr.querySelectorAll("td");
                  if (tds.length < 7) continue;
                  // ⚠解釈はNode側(parseMyPageRowCells)。ここは生データのみ。
                  const cellHtmls = Array.from(tds)
                      .slice(0, 12)
                      .map((td) => (td as HTMLElement).innerHTML ?? "");
                  rows.push(cellHtmls);
                }
                return JSON.stringify({ loading: false, rows });
              },
              JSON.stringify({
                probe: "mypage-scan",
                tableSel: REGISTRY_SELECTORS.myPageTable,
              }),
            )) as string;
            const scan = JSON.parse(scanJson) as {
              loading: boolean;
              rows: string[][];
            };
            if (scan.loading) {
              scanLoading = true;
              break; // 読み込み中はこの attempt を諦め、リロード後にやり直す
            }
            let indexInPage = 0;
            for (const cells of scan.rows) {
              const parsed = parseMyPageRowCells(cells);
              // ⚠位置は**実データ行だけを数えた並び**(DOM側も同じ条件で絞る)。
              if (parsed) {
                scannedRows.push({ ...parsed, pageNo, indexInPage });
                indexInPage += 1;
              }
            }
            if (!(await myPageHasNext())) break;
            await page.click(REGISTRY_SELECTORS.myPageNextButton);
            await sleep(1200);
          }
          const picked = scanLoading
            ? null
            : pickChargedMyPageRow(scannedRows, {
                targetKey,
                kuiki: expectedKuiki,
                // マイページの所在は先頭に種別が付く(probe16 実測)。
                kindLabel: isBuilding ? "建物" : "土地",
                // 同じ筆で所有者事項と全部事項の両方を買っていると取り違える。
                certificateType: input.certificateType,
                baselineReceiptNos: baselineTrIds,
              });
          if (picked && picked.readyNow) {
            // ---- 選択フェーズ: 同定した行を**受付番号**で選び直す。
            // 走査と選択を分けたぶん、選択は強いキーで行い取り違えを塞ぐ。
            await resetMyPageToFirst();
            // 受付番号→**(ページ番号, ページ内位置)**へ変換(@codex #393 R2 P1)。
            const target = scannedRows.find(
              (r) => r.receiptNo === picked.receiptNo,
            );
            // 対象ページまでページ送り。⚠**届かなければ選ばない**(@codex #393 R3 P1)。
            // 送りが途中で止まった状態で位置だけ当てると、同じ位置の**別の行**を
            // 選び、支払済みでない/別の筆のPDFを添付し得る。
            let hopped = 0;
            for (; target && hopped < target.pageNo; hopped++) {
              if (!(await myPageHasNext())) break;
              await page.click(REGISTRY_SELECTORS.myPageNextButton);
              await sleep(1200);
            }
            const reachedPage = !!target && hopped === target.pageNo;
            // 位置が確定していても**受付番号を選ぶ前後で実測**する(位置ズレ検出)。
            for (let once = 0; once < 1 && !ready && target && reachedPage; once++) {
              // ①選ぶ前: その位置の行のセルを読む(解釈は Node 側)。
              const peekJson = (await page.evaluate(
                (json) => {
                  const { tableSel, rowIndex } = JSON.parse(json) as {
                    tableSel: string;
                    rowIndex: number;
                  };
                  const rows = Array.from(
                    document.querySelectorAll(`${tableSel} tbody tr`),
                  ).filter((tr) => tr.querySelectorAll("td").length >= 7);
                  const row = rows[rowIndex];
                  if (!row) return JSON.stringify({ found: false, cells: [] });
                  const cells = Array.from(row.querySelectorAll("td"))
                    .slice(0, 12)
                    .map((td) => (td as HTMLElement).innerHTML ?? "");
                  return JSON.stringify({ found: true, cells });
                },
                JSON.stringify({
                  probe: "mypage-peek",
                  tableSel: REGISTRY_SELECTORS.myPageTable,
                  rowIndex: target.indexInPage,
                }),
              )) as string;
              const peek = JSON.parse(peekJson) as {
                found: boolean;
                cells: string[];
              };
              const peeked = peek.found ? parseMyPageRowCells(peek.cells) : null;
              if (!peeked || peeked.receiptNo !== picked.receiptNo) {
                break; // 表が動いた=走査からやり直す(課金後なので中止はしない)
              }
              // ②選ぶ: 位置で check し、**選ばれた行のセル**を読み戻す。
              const selJson = (await page.evaluate(
                (json) => {
                  const { tableSel, rowIndex } = JSON.parse(json) as {
                    tableSel: string;
                    rowIndex: number;
                  };
                  const rows = Array.from(
                    document.querySelectorAll(`${tableSel} tbody tr`),
                  ).filter((tr) => tr.querySelectorAll("td").length >= 7);
                  const row = rows[rowIndex] ?? null;
                  if (!row) return JSON.stringify({ result: "not-found" });
                  for (const cb of Array.from(
                    document.querySelectorAll(
                      `${tableSel} tbody input[type="checkbox"]`,
                    ),
                  ) as HTMLInputElement[]) {
                    if (cb.checked) cb.click();
                  }
                  const cb = row.querySelector(
                    'input[type="checkbox"]',
                  ) as HTMLInputElement | null;
                  if (!cb) return JSON.stringify({ result: "select-failed" });
                  if (!cb.checked) cb.click();
                  // read-back: check されているのは1件か + **その行のセル**を返す
                  // (受付番号の一致は Node 側で確かめる)。
                  const checkedRows = Array.from(
                    document.querySelectorAll(`${tableSel} tbody tr`),
                  ).filter((tr) => {
                    const x = tr.querySelector(
                      'input[type="checkbox"]',
                    ) as HTMLInputElement | null;
                    return x?.checked === true;
                  });
                  if (checkedRows.length !== 1) {
                    return JSON.stringify({ result: "select-failed" });
                  }
                  const cells = Array.from(checkedRows[0].querySelectorAll("td"))
                    .slice(0, 12)
                    .map((td) => (td as HTMLElement).innerHTML ?? "");
                  return JSON.stringify({ result: "checked", cells });
                },
                JSON.stringify({
                  probe: "mypage-select",
                  tableSel: REGISTRY_SELECTORS.myPageTable,
                  rowIndex: target.indexInPage,
                }),
              )) as string;
              const sel = JSON.parse(selJson) as {
                result: string;
                cells?: string[];
              };
              if (sel.result === "checked") {
                const selected = parseMyPageRowCells(sel.cells ?? []);
                // ⚠**選んだ行の受付番号が一致して初めて ready**(位置だけでは信じない)。
                if (selected && selected.receiptNo === picked.receiptNo) {
                  ready = true;
                }
                break;
              }
              // not-found / select-failed: ページ送りで探し回らない(位置は走査で
              // 確定済み。ずれていたら**表が動いた**ということなので、リロードして
              // 走査からやり直す=次の attempt へ)。
              break;
            }
          }
          // picked が null(まだ行が出ない)/準備前(readyNow=false)は次の attempt へ。
          // ⚠準備前でも**古い ready 行へ乗り換えない**(同一性が先・準備状態は後)。
          if (!ready) {
            await domClick(REGISTRY_SELECTORS.myPageReloadButton).catch(() => {});
          }
        }
        if (!ready) {
          throw new RegistryFetchError("charged_but_failed");
        }
        // ここは断定してよい: ready=true は対象行が「請求済」かつDL可能と**実測**できた後。
        reportLive("請求済みを確認しました(課金済み)。書類(PDF)を保存しています");
        // ⚠課金後の待ちには明示予算を渡す(@codex R9 P1)。渡さないと page の既定
        // timeout(通常予算=例30秒)が provider の延長予算(10分)より先に打ち切る。
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: PAID_DOWNLOAD_WAIT_MS }),
          domClick(REGISTRY_SELECTORS.downloadButton),
        ]);
        const stream = await download.createReadStream();
        if (!stream) {
          throw new RegistryFetchError("charged_but_failed");
        }
        return await readStreamToBuffer(stream);
      } catch (err) {
        // ⚠課金境界を越えている。分類を charged_but_failed に固定し(既にそうならそのまま)、
        // 詳細は診断ログへ(secret/PII 除去済みの要約のみ)。
        console.warn(
          "[registry-fetch] paid flow failed AFTER charge:",
          summarizeRegistrySearchError(err),
        );
        if (err instanceof RegistryFetchError && err.code === "charged_but_failed") {
          throw err;
        }
        throw new RegistryFetchError("charged_but_failed");
      }
    },
    /**
     * 【回収】既に**課金済み**の謄本PDFを、再課金なしで取り込む(2026-08-19)。
     *
     * ⚠**このメソッドは課金しない**。請求(#btn_seikyu)・確定(fuBtnForward)・
     * 確認ダイアログのＯＫには**一切触れない**(コードに呼び出しを書かない)。
     * やることは「ログイン → マイページ → 請求済かつ対象の行を受付番号で選ぶ →
     * 表示・保存(無料)」だけ。第8回テストのように課金は成立したのにPDFを
     * 取り逃した場合の救済で、PDF取得期限内なら何度でも取り直せる。
     */
    async recoverRegistryPdfByLocation(input: {
      address: string;
      lotNumber?: string | null;
      buildingNumber?: string | null;
      certificateType: RegistryCertificateType;
      /** 区域キーを作るときに末尾から外してよい候補(物件行の実値・@codex R12 P2)。 */
      addressIdentifiers?: Array<string | null | undefined>;
      baseUrl?: string;
      live?: RegistryLiveReporter;
    }): Promise<Buffer> {
      const reportLive = (label: string): void => {
        try {
          const live = input.live;
          if (!live) return;
          const seq = live.step(label);
          // 撮影は本流の await チェーンに乗せない(既存の実況と同じ流儀)。
          void (async () => {
            try {
              const raw = await page.screenshot?.({
                type: "jpeg",
                quality: 55,
                timeout: LIVE_SCREENSHOT_TIMEOUT_MS,
              });
              if (raw) {
                live.attachShot(
                  seq,
                  raw instanceof Uint8Array ? raw : new Uint8Array(raw),
                );
              }
            } catch {
              // 撮影失敗は文字進行のみで続行。
            }
          })();
        } catch {
          // 実況は best-effort(本流を止めない)。
        }
      };
      const domClick = (sel: string) =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el && typeof (el as { click?: unknown }).click === "function") {
            (el as unknown as { click: () => void }).click();
          }
        }, sel);
      const sleep = (ms: number) =>
        page
          .waitForFunction(() => false, undefined, { timeout: ms })
          .catch(() => {});
      const pagerEnabled = async (sel: string): Promise<boolean> =>
        (await page.evaluate((s) => {
          const b = document.querySelector(s) as {
            disabled?: boolean;
            className?: string;
          } | null;
          if (!b || b.disabled) return false;
          const st = getComputedStyle(b as unknown as Element);
          if (st.display === "none" || st.visibility === "hidden") return false;
          return !/disabled/.test(String(b.className ?? ""));
        }, sel)) === true;
      const hasNext = () => pagerEnabled(REGISTRY_SELECTORS.myPageNextButton);
      /** いま表示中のページを読む(表が『データ取得中』なら loading)。 */
      const readCurrentPage = async (): Promise<{
        loading: boolean;
        rows: string[][];
      }> => {
        const raw = (await page.evaluate(
          (json) => {
            const { tableSel } = JSON.parse(json) as { tableSel: string };
            const t = document.querySelector(tableSel);
            if (!t || /データ取得中/.test(t.textContent ?? "")) {
              return JSON.stringify({ loading: true, rows: [] });
            }
            const rows: string[][] = [];
            for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
              const tds = tr.querySelectorAll("td");
              if (tds.length < 7) continue;
              rows.push(
                Array.from(tds)
                  .slice(0, 12)
                  .map((td) => (td as HTMLElement).innerHTML ?? ""),
              );
            }
            return JSON.stringify({ loading: false, rows });
          },
          JSON.stringify({
            probe: "mypage-scan",
            tableSel: REGISTRY_SELECTORS.myPageTable,
          }),
        )) as string;
        return JSON.parse(raw) as { loading: boolean; rows: string[][] };
      };
      /**
       * 表の読み込みが終わるまで待つ(@codex #394 R11 P2)。
       * ⚠固定待ちのままページ送りの判定や行の選択へ進むと、途中で止まったり
       *   読み込み中の表を見て『無い』と言ったりする。
       */
      const waitPageLoaded = async (): Promise<boolean> => {
        for (let i = 0; i < 4; i++) {
          if (!(await readCurrentPage()).loading) return true;
          await sleep(1500);
        }
        return !(await readCurrentPage()).loading;
      };
      /**
       * 1ページ目まで戻る。**戻り切れたかを返す**(@codex #394 R5 P2)。
       * ⚠戻り切れないまま選択に進むと、位置(ページ番号)の意味がずれ、
       *   受付番号の読み戻しで必ず外れる=取り込めるはずのPDFを取り逃す。
       *   走査が60ページまで進む以上、戻りも同じだけ必要。
       */
      const resetToFirst = async (): Promise<boolean> => {
        for (let i = 0; i < RECOVER_MAX_PAGES + 2; i++) {
          // ⚠**読み込み完了を待ってから** prev の状態を見る(@codex #394 R13 P2)。
          //   『データ取得中』の間は prev が一時的に押せなくなることがあり、それを
          //   「1ページ目に着いた」と読むと、以降のページ番号の意味がずれて
          //   受付番号の読み戻しで必ず外す=取り込めるPDFを取り逃す。
          if (!(await waitPageLoaded())) return false;
          if (!(await pagerEnabled(REGISTRY_SELECTORS.myPagePrevButton))) {
            return true;
          }
          await page.click(REGISTRY_SELECTORS.myPagePrevButton);
          await sleep(800);
        }
        if (!(await waitPageLoaded())) return false;
        return !(await pagerEnabled(REGISTRY_SELECTORS.myPagePrevButton));
      };
      /** 戻り切れないときの共通の切り上げ(『無い』とは言わない)。 */
      const failNotRewound = (): never => {
        console.warn(
          "[registry-fetch] recover: could not rewind to first page (not charged)",
        );
        reportLive(
          "一覧を先頭まで戻せませんでした(課金はしていません)。時間をおいて再度お試しください",
        );
        throw new RegistryFetchError("provider_error");
      };
      // 選び方は純関数に集約(検査側とずれない)。
      const { isBuilding, value: rawTarget } =
        effectiveLocationIdentifier(input);
      const targetKey = normalizeChibanForDialog(rawTarget);
      if (targetKey.length === 0) {
        throw new RegistryFetchError("provider_error");
      }
      const base = input.baseUrl ?? DEFAULT_REGISTRY_BASE_URL;
      try {
        reportLive("取得済みの書類を探しています(課金はしません)");
        await page.goto(base + REGISTRY_MYPAGE_PATH, {});
        await page.waitForSelector(REGISTRY_SELECTORS.myPageTable, {
          state: "attached",
          timeout: DIALOG_RESULT_TIMEOUT_MS,
        });
        // 「すべて」表示にしてから全ページ走査(請求済に絞ると取りこぼす場面がある)。
        await page.evaluate(
          (json) => {
            const { filterSel, label } = JSON.parse(json) as {
              filterSel: string;
              label: string;
            };
            const el = document.querySelector(filterSel) as HTMLSelectElement | null;
            if (!el) return;
            const opt = Array.from(el.options).find(
              (o) => (o.textContent ?? "").trim() === label,
            );
            if (!opt) return;
            if (el.value !== opt.value) {
              el.value = opt.value;
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          },
          JSON.stringify({
            probe: "recover-filter",
            filterSel: REGISTRY_SELECTORS.myPageFilter,
            label: "すべて",
          }),
        );
        await sleep(2000);
        // ⚠**掛けたつもりを信用しない**(@codex #394 R7 P2)。select には前回操作の
        //   選択(「未請求」等)が残り得る。絞り込まれた一部だけを全履歴と思って走査
        //   すると、買った書類を『無い』ことにしてしまう。選択中 option を実測する。
        const allSelected =
          (await page.evaluate(
            (json) => {
              const { filterSel } = JSON.parse(json) as { filterSel: string };
              const el = document.querySelector(
                filterSel,
              ) as HTMLSelectElement | null;
              const opt = el?.selectedOptions?.[0];
              return ((opt?.textContent ?? "").trim() === "すべて") === true;
            },
            JSON.stringify({
              probe: "filter-verify",
              filterSel: REGISTRY_SELECTORS.myPageFilter,
            }),
          )) === true;
        if (!allSelected) {
          console.warn(
            "[registry-fetch] recover: history filter not verified (not charged)",
          );
          reportLive(
            "一覧の表示を『すべて』に切り替えられませんでした(課金はしていません)。時間をおいて再度お試しください",
          );
          throw new RegistryFetchError("provider_error");
        }
        const scanned: Array<
          MyPageScanRow & { pageNo: number; indexInPage: number }
        > = [];
        if (!(await resetToFirst())) failNotRewound();
        // ⚠**途中で諦めたことを覚えておく**(@codex #394 R4 P2)。上限で抜けたのに
        //   『見つかりません』と言うと、まだ期限内の購入を『無い』ことにしてしまう。
        let truncated = false;
        for (let pageNo = 0; pageNo < RECOVER_MAX_PAGES; pageNo++) {
          // ⚠『データ取得中』はまだ結論が出ていない。待ってから読む。それでも
          //   読めなければ**『無い』とは言わず**見切れた扱いにする(@codex R5 P2)。
          if (!(await waitPageLoaded())) {
            truncated = true;
            break;
          }
          const scan = await readCurrentPage();
          let indexInPage = 0;
          for (const cells of scan.rows) {
            const parsed = parseMyPageRowCells(cells);
            if (parsed) {
              scanned.push({ ...parsed, pageNo, indexInPage });
              indexInPage += 1;
            }
          }
          if (!(await hasNext())) break;
          if (pageNo === RECOVER_MAX_PAGES - 1) {
            truncated = true; // まだ次があるのに上限で抜ける
            break;
          }
          await page.click(REGISTRY_SELECTORS.myPageNextButton);
          await sleep(1200);
        }
        // ⚠回収では基準(課金前の受付番号)が無いので、**請求済 × 期限内**を必須にする
        // (未請求の行=まだ買っていない行を掴まない)。
        const picked = pickChargedMyPageRow(scanned, {
          targetKey,
          // ⚠物件の所在は末尾に地番まで入っていることがある(本番データ実測)。
          //   区域だけにしてから照合する(そのままだと残りが空になり正しい行を弾く)。
          // ⚠所在の末尾には**対象でない方の識別子**(建物で探すときの地番)が
          //   入っていることがある。対象→もう一方の順に外して区域だけにする。
          // ⚠外してよい候補は「対象 → もう一方 → 物件行の実値」の順。
          //   候補経由の建物取得は lotNumber を持たないので、物件行の値で補う。
          kuiki: stripTrailingIdentifierFromKuiki(input.address, [
            rawTarget,
            isBuilding ? input.lotNumber : input.buildingNumber,
            ...(input.addressIdentifiers ?? []),
          ]),
          kindLabel: isBuilding ? "建物" : "土地",
          // 同じ筆で両方買っている場合に、要求した種類の行だけを取り込む。
          certificateType: input.certificateType,
          baselineReceiptNos: new Set<string>(),
          // 回収は『いま取り込めるもの』が目的。最新が期限切れでも、
          // まだ生きている購入があればそれを取り込む(@codex #394 R9 P2)。
          requireReady: true,
          // 種類が読めない行は採らない(回収には裏付けが無い・@codex R11 P2)。
          strictCertificateType: true,
        });
        if ((!picked || !picked.readyNow) && truncated) {
          // 履歴を最後まで見ていない=『無い』と断定できない。
          console.warn(
            "[registry-fetch] recover: history truncated (not charged)",
            { pages: RECOVER_MAX_PAGES, scanned: scanned.length },
          );
          reportLive(
            `履歴が多く、最後まで確認できませんでした(${RECOVER_MAX_PAGES}ページ分を確認・課金はしていません)`,
          );
          throw new RegistryFetchError("provider_error");
        }
        if (!picked || !picked.readyNow) {
          // ⚠原因の切り分けは**数だけ**で行う(所在・地番・受付番号は出さない)。
          //   一覧0件=たどり着けていない / 一覧はあるのに0一致=同定の問題、と分かれる。
          const readyCount = scanned.filter(
            (r) => r.status.trim() === "請求済" && r.expiry.trim() !== "",
          ).length;
          console.warn(
            "[registry-fetch] recover: no matching row (not charged)",
            { scanned: scanned.length, ready: readyCount },
          );
          reportLive(
            `取得済みの書類が見つかりませんでした(一覧${scanned.length}件・取り込める状態${readyCount}件を確認・課金はしていません)`,
          );
          throw new RegistryFetchError("not_found");
        }
        const target = scanned.find((r) => r.receiptNo === picked.receiptNo);
        if (!target) throw new RegistryFetchError("not_found");
        if (!(await resetToFirst())) failNotRewound();
        let hopped = 0;
        for (; hopped < target.pageNo; hopped++) {
          // ⚠**各ページの読み込み完了を待ってから**次の判定へ(@codex #394 R11 P2)。
          //   読み込み中に hasNext を見ると途中で止まり、別のページで行を選ぶ。
          if (!(await waitPageLoaded())) break;
          if (!(await hasNext())) break;
          await page.click(REGISTRY_SELECTORS.myPageNextButton);
          await sleep(1200);
        }
        if (hopped !== target.pageNo) {
          // ⚠**『無い』ではない**(@codex #394 R14 P2)。受付番号は走査で見つけて
          //   いる。移動できなかっただけなので、そう伝える(『無い』と言うと
          //   期限内の書類を諦めさせてしまう)。
          console.warn(
            "[registry-fetch] recover: could not reach the target page (not charged)",
            { wanted: target.pageNo, reached: hopped },
          );
          reportLive(
            "一覧の目的のページまで進めませんでした(課金はしていません)。時間をおいて再度お試しください",
          );
          throw new RegistryFetchError("provider_error");
        }
        // 目的のページでも、選ぶ前に読み込み完了を確かめる。
        if (!(await waitPageLoaded())) {
          reportLive(
            "一覧の読み込みが終わりませんでした(課金はしていません)。時間をおいて再度お試しください",
          );
          throw new RegistryFetchError("provider_error");
        }
        // 選んだ行の受付番号を読み戻して一致を実測(位置ズレで別の筆を取り込まない)。
        // ⚠走査と選択の間に口座へ**別の購入が入る**と位置がずれる(共有口座)。
        //   検知したら**いまのページを読み直して受付番号で位置を取り直す**
        //   (@codex #394 R15 P2)。それでも駄目なら『無い』ではなく一時的な失敗。
        const selectRowAt = async (
          rowIndex: number,
        ): Promise<MyPageScanRow | null> => {
          const json = (await page.evaluate(
            (raw) => {
              const { tableSel, rowIndex: idx } = JSON.parse(raw) as {
                tableSel: string;
                rowIndex: number;
              };
              const rows = Array.from(
                document.querySelectorAll(tableSel + " tbody tr"),
              ).filter((tr) => tr.querySelectorAll("td").length >= 7);
              const row = rows[idx] ?? null;
              if (!row) return JSON.stringify({ result: "not-found" });
              for (const cb of Array.from(
                document.querySelectorAll(
                  tableSel + " tbody " + 'input[type="checkbox"]',
                ),
              ) as HTMLInputElement[]) {
                if (cb.checked) cb.click();
              }
              const cb = row.querySelector(
                'input[type="checkbox"]',
              ) as HTMLInputElement | null;
              if (!cb) return JSON.stringify({ result: "select-failed" });
              if (!cb.checked) cb.click();
              const checkedRows = Array.from(
                document.querySelectorAll(tableSel + " tbody tr"),
              ).filter((tr) => {
                const x = tr.querySelector(
                  'input[type="checkbox"]',
                ) as HTMLInputElement | null;
                return x?.checked === true;
              });
              if (checkedRows.length !== 1) {
                return JSON.stringify({ result: "select-failed" });
              }
              const cells = Array.from(checkedRows[0].querySelectorAll("td"))
                .slice(0, 12)
                .map((td) => (td as HTMLElement).innerHTML ?? "");
              return JSON.stringify({ result: "checked", cells });
            },
            JSON.stringify({
              probe: "mypage-select",
              tableSel: REGISTRY_SELECTORS.myPageTable,
              rowIndex,
            }),
          )) as string;
          const parsedSel = JSON.parse(json) as {
            result: string;
            cells?: string[];
          };
          if (parsedSel.result !== "checked") return null;
          return parseMyPageRowCells(parsedSel.cells ?? []);
        };
        let selected = await selectRowAt(target.indexInPage);
        if (!selected || selected.receiptNo !== picked.receiptNo) {
          // 位置がずれた。いまのページを読み直し、受付番号で位置を取り直す。
          const rescan = await readCurrentPage();
          const movedTo = rescan.loading
            ? -1
            : rescan.rows
                .map((cells) => parseMyPageRowCells(cells))
                .findIndex((row) => row?.receiptNo === picked.receiptNo);
          selected = movedTo >= 0 ? await selectRowAt(movedTo) : null;
        }
        if (!selected || selected.receiptNo !== picked.receiptNo) {
          console.warn(
            "[registry-fetch] recover: row moved before selection (not charged)",
          );
          reportLive(
            "一覧が更新されて対象の行を選べませんでした(課金はしていません)。時間をおいて再度お試しください",
          );
          throw new RegistryFetchError("provider_error");
        }
        reportLive("取得済みの書類(PDF)を保存しています(課金はしていません)");
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: PAID_DOWNLOAD_WAIT_MS }),
          domClick(REGISTRY_SELECTORS.downloadButton),
        ]);
        const stream = await download.createReadStream();
        if (!stream) throw new RegistryFetchError("provider_error");
        return await readStreamToBuffer(stream);
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        console.warn(
          "[registry-fetch] recover failed (not charged):",
          summarizeRegistrySearchError(err),
        );
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
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
  deps: {
    chromiumLoader?: () => Promise<RegistryChromiumLike>;
    /** テスト用の時計差し替え (goto が予算を食う状況の再現に使う)。 */
    now?: () => number;
  } = {},
): RegistryBrowserFactory | undefined {
  // 本番経路は明示 opt-in + セレクタ校正フラグの両方を要求（テスト注入時は不要）。
  // CodexP1: 校正フラグ無し（TODO プレースホルダのまま）の opt-in では誤セレクタで実サイトを
  //   操作してしまうため、有効化せず undefined を維持する（= 501 維持）。
  if (
    !deps.chromiumLoader &&
    (process.env.REGISTRY_FETCH_PROVIDER !== "official" || !areRegistrySelectorsCalibrated())
  ) {
    return undefined;
  }
  const load = deps.chromiumLoader ?? defaultChromiumLoader;
  const timeoutRaw = process.env.REGISTRY_FETCH_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  // CodexP2: login パスは env（REGISTRY_FETCH_LOGIN_PATH）で上書き可能（誤った固定値で確定しない）。
  //   未設定なら DEFAULT_REGISTRY_LOGIN_PATH（"/TeikyoUketsuke/"・実測確定）。非PII・非secret。
  const loginPath = process.env.REGISTRY_FETCH_LOGIN_PATH || DEFAULT_REGISTRY_LOGIN_PATH;

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
    return createPlaywrightRegistryPage(
      { browser, context, page },
      {
        loginPath,
        formDetectTimeoutMs: resolveLoginFormDetectMs(
          Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        ),
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        now: deps.now,
      },
    );
  };
}

/** close を best-effort で呼ぶ（部分失敗時のリソース解放・close 例外は握りつぶす）。 */
async function closeQuietly(handle: { close(): Promise<void> } | undefined): Promise<void> {
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

/**
 * 有料取得の最小間隔(ms)。REGISTRY_FETCH_MIN_INTERVAL_MS があればそれ、無ければ既定 60000
 * (throttle の DEFAULT_MIN_INTERVAL_MS と一致)。一括取得が rate_limited のときの再試行待ち
 * (retryAfterMs)にも使う=固定値で待って何度も rate_limited になるのを避ける。
 */
export function getRegistryFetchMinIntervalMs(): number {
  const raw = process.env.REGISTRY_FETCH_MIN_INTERVAL_MS;
  const parsed = raw ? Number(raw) : undefined;
  return parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function getSharedRegistryFetchThrottle(): RegistryFetchThrottle {
  if (!sharedRegistryFetchThrottle) {
    const raw = process.env.REGISTRY_FETCH_MIN_INTERVAL_MS;
    const parsed = raw ? Number(raw) : undefined;
    const minIntervalMs = parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    // burst は既定1（1件/分の保守的ガード）。検索→取得の対は official-provider が search/fetch で
    // 別 throttle キーを使うことで両立させる（@codex P2: burst=2 は直 fetch 連打も許すため不採用）。
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
  // credentials 注入があれば優先（DB-over-env は呼び出し側が loadRegistryFetchCredentials で解決）。
  // 未注入時は env を直接読む（後方互換 = 既存テスト/env 経路は不変）。
  const loginId = options.credentials?.loginId ?? process.env.REGISTRY_FETCH_LOGIN_ID;
  const password = options.credentials?.password ?? process.env.REGISTRY_FETCH_PASSWORD;

  // 資格情報のいずれか欠落 → null（= route 501 維持 = 本番挙動不変）。
  if (!loginId || !password) {
    return null;
  }

  // CodexP2: readiness（browserFactory）が無ければ実取得不能 → null（= 501 維持）。
  // PR-1 では default factory が undefined ゆえ、env 設定済みでもここで null になる。
  const browserFactory = options.browserFactory ?? resolveDefaultRegistryBrowserFactory();
  if (!browserFactory) {
    return null;
  }

  // baseUrl(ログイン先 origin)は env のみ(ops 管理)。credentials(DB=設定画面 admin)からは
  // 受け取らない=保存済み資格情報を攻撃者 origin へ送信させる経路を作らない(@codex P1)。
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
  // 所在検索は自動取得と独立の校正フラグ。両方 true でのみ所在検索が露出(誤露出防止)。
  const locationSearchCalibrated = process.env.REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED === "true";
  return createOfficialRegistryProvider({
    loginId,
    password,
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    browserFactory,
    throttle: getSharedRegistryFetchThrottle(),
    supportsLocationSearch: locationSearchCalibrated,
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
 * 段階②(2026-08-01): 候補からの**有料取得**が使えるかの capability。
 * 所在検索(無料)より さらに厳しく、専用オプトイン `REGISTRY_FETCH_PURCHASE_ENABLED`
 * を要求する(@codex #345 P1: 無料検索の校正フラグだけで課金操作を露出させない)。
 * server 側 enforce(runRegistryAutoFetch の 501)と**対**。UI はこれが false のとき
 * 取得ボタンを準備中表示にする。
 */
export function isRegistryPurchaseConfigured(
  options: ResolveRegistryFetchProviderOptions = {},
): boolean {
  return (
    process.env.REGISTRY_FETCH_PURCHASE_ENABLED === "true" &&
    isRegistryLocationSearchConfigured(options)
  );
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
      // 所在検索取得の指紋再検証用（@codex P2）。
      address: true,
      lotNumber: true,
      buildingNumber: true,
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }

  // 3. 物件スコープ（field_staff は担当/作成物件のみ）。既存 Mode A と同じ 403 方針。
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件にアクセスする権限がありません", "FORBIDDEN");
  }

  // 3.5 @codex P2: 所在検索取得の override は「今 version-lock する行の指紋」が resolve 時と
  //     一致する場合だけ使う。resolve のスナップショットとこの read の間に物件が編集されていたら
  //     429/lock 前に 409 で弾く（この read〜fetch は下の楽観ロックで直列化される）。
  if (
    args.expectedFingerprint !== undefined &&
    fingerprintProperty(property) !== args.expectedFingerprint
  ) {
    throw new ApiError(
      409,
      "物件情報が変わりました。もう一度検索してから取得してください",
      "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
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

  // 4.5 段階②(2026-07-31): 有料取得の**二重課金ガード(台帳)**。
  //     サイト側の歯止め(請求済は再請求不可)は「確定」のたびに新しいカート行ができるため
  //     アプリからの再実行には効かない。**アプリ側の台帳(AuditLog)を主**に、同じ
  //     物件×地番×種別 の購入(成功 or 課金後失敗)が直近にあれば実行前に止める。
  //     台帳に残すのは鍵の**ハッシュのみ**(地番=秘匿情報を監査に載せない)。
  // ⚠番号があれば番号取得(無料フローと同じ扱い)が優先され購入は起きない=台帳も見ない。
  let purchaseKeyHash: string | null = null;
  // ⚠**種別は1か所で確定させ、鍵と provider 請求の両方で同じ値を使う**。
  //   片方だけ owner に残すと all を買ったのに owner 鍵で照合し二重課金ガードが破れる。
  const certificateType: RegistryCertificateType = args.certificateType ?? DEFAULT_CERTIFICATE_TYPE;
  // 回収モード: 課金しない経路(既に買った書類の取り込み)。
  const isRecover = args.mode === "recover";
  const willPurchaseByLocation =
    !isRecover &&
    !!args.locationCandidate &&
    !(args.realEstateNumber ?? property.realEstateNumber)?.trim();
  // ⚠回収でも「対象と所在があること・地番の書き方が読めること」は同じ規則で検査する
  // (別の筆を取り込まないため)。違うのは課金スイッチと台帳ガードを通らない点だけ。
  // ⚠回収は**候補が無くても物件自身の地番で実行できる**(@codex #394 R6 P1)。
  //   取込が途中まで進むと物件に不動産番号が入り、所在検索が「対象外」になるため、
  //   検索の中にある入口だけだと**買った書類に二度と手が届かない**。
  //   ⚠課金しない経路なので候補キャッシュ(誤課金防止の仕組み)に依存しなくてよい。
  //   取り違え防止は同定側(区域+地番+種別+謄本の種類+請求済+期限内)が担う。
  const recoverLocation = isRecover
    ? (args.locationCandidate ??
      // ⚠両方持つ物件は**指定された方だけ**を対象にする(@codex #394 R13 P1)。
      //   指定が無ければ従来どおり(家屋番号があれば建物)。
      (args.recoverKind === "land"
        ? { lotNumber: property.lotNumber, buildingNumber: null }
        : args.recoverKind === "building"
          ? { lotNumber: null, buildingNumber: property.buildingNumber }
          : {
              lotNumber: property.lotNumber,
              buildingNumber: property.buildingNumber,
            }))
    : args.locationCandidate;
  if (isRecover) {
    // ⚠**provider が実際に使う識別子**を検査する(建物優先。@codex #394 R8 P2)。
    const lotOrBuilding = effectiveLocationIdentifier(
      recoverLocation ?? {},
    ).value;
    // ⚠**候補なしの回収は、画面が見せていた内容と一致するときだけ実行する**
    //   (@codex #394 R20 P1)。確認の後に誰かが地番を編集していると、利用者が
    //   見たものと違う筆のPDFを取り込み、所有者の紐付けまで書き換わる。
    //   候補経由には指紋(expectedFingerprint)があるので、そちらは従来どおり。
    //   ⚠送られた値は**一致判定にのみ使う**(取得キーは常にDBの値)。
    if (!args.locationCandidate) {
      // ⚠**両方持つ物件で種別の指定が無ければ実行しない**(@codex #394 R21 P1)。
      //   既定の選び方(家屋番号優先)に黙って倒すと、土地のつもりで建物のPDFと
      //   所有者情報を取り込みかねない。選ばせてから実行する。
      if (
        args.recoverKind === undefined &&
        (property.lotNumber ?? "").trim() &&
        (property.buildingNumber ?? "").trim()
      ) {
        throw new ApiError(
          409,
          "土地と建物のどちらを取り込むかを選んでください",
          "REGISTRY_RECOVER_KIND_REQUIRED",
        );
      }
      if (
        args.recoverExpectedVersion !== undefined &&
        property.version !== args.recoverExpectedVersion
      ) {
        throw new ApiError(
          409,
          "物件情報が変わりました。画面を開き直してからもう一度お試しください",
          "REGISTRY_RECOVER_PROPERTY_CHANGED",
        );
      }
      const expectedAddress = (args.recoverExpectedAddress ?? "").trim();
      if (
        expectedAddress &&
        normalizeKuikiForCompare(expectedAddress) !==
          normalizeKuikiForCompare(property.address ?? "")
      ) {
        throw new ApiError(
          409,
          "物件情報が変わりました。画面を開き直してからもう一度お試しください",
          "REGISTRY_RECOVER_PROPERTY_CHANGED",
        );
      }
      const expectedId = (args.recoverExpectedIdentifier ?? "").trim();
      if (
        expectedId &&
        normalizeChibanForDialog(expectedId) !==
          normalizeChibanForDialog(lotOrBuilding)
      ) {
        throw new ApiError(
          409,
          "物件情報が変わりました。画面を開き直してからもう一度お試しください",
          "REGISTRY_RECOVER_PROPERTY_CHANGED",
        );
      }
    }
    if (!lotOrBuilding || !(property.address ?? "").trim()) {
      throw new ApiError(
        409,
        "取り込む対象が特定できません。物件の所在・地番をご確認ください",
        "REGISTRY_RECOVER_TARGET_NOT_FOUND",
      );
    }
    if (!isReadableChiban(lotOrBuilding)) {
      throw new ApiError(
        422,
        "地番の書き方が読み取れません。地図に表示されたとおりに入力してください",
        "REGISTRY_OBTAIN_IDENTIFIER_INVALID",
      );
    }
  }
  if (willPurchaseByLocation && args.locationCandidate) {
    // ⚠有料取得の専用オプトイン(@codex #345 P1)。所在検索(無料)の校正フラグだけで
    // 課金操作まで露出させない。実課金1回の通しテストを発注者承認のもとで終えるまで、
    // 本番ではこのフラグを立てない=fail-closed。UI 側 capability(registryPurchase)と対。
    if (process.env.REGISTRY_FETCH_PURCHASE_ENABLED !== "true") {
      throw new ApiError(
        501,
        "謄本の有料取得はまだ有効化されていません（管理者にお問い合わせください）",
        "REGISTRY_PURCHASE_NOT_ENABLED",
      );
    }
    // ⚠検査する値と provider が探す値を必ず一致させる(建物優先。@codex #394 R8 P2)。
    const lotOrBuilding = effectiveLocationIdentifier(
      args.locationCandidate,
    ).value;
    if (!lotOrBuilding || !(property.address ?? "").trim()) {
      // 買う対象(地番/家屋番号)か所在が無い候補は購入できない(課金前・fail-closed)。
      throw new ApiError(
        409,
        "選択した候補が見つかりません。物件情報が変わった可能性があります。もう一度検索してから取得してください",
        "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
      );
    }
    // ⚠**形式まで見る**(設計 §4.4)。空でないことだけを見ると、編集画面・PATCH API・
    //   CSV取込から入った `abc1x2` のような値が normalizeChibanForDialog で `12` に
    //   潰され、**別の筆**を買うところまで進む。
    //   ⚠取得は検索とは別の入口なので、検索側だけ塞いでも素通りする。
    //   検索の入口と**同じ判定関数**を使う(2か所に書くとずれる)。
    if (!isReadableChiban(lotOrBuilding)) {
      throw new ApiError(
        422,
        "地番の書き方が読み取れません。地図に表示されたとおりに入力してください",
        "REGISTRY_OBTAIN_IDENTIFIER_INVALID",
      );
    }
    purchaseKeyHash = createHash("sha256")
      .update(
        purchaseIdempotencyKey({
          propertyId,
          lotOrBuilding,
          certificateType,
        }),
      )
      .digest("hex")
      .slice(0, 32);
    const prior = await prisma.auditLog.findFirst({
      where: {
        action: REGISTRY_PURCHASE_AUDIT_ACTION,
        targetId: propertyId,
        createdAt: {
          gte: new Date(Date.now() - PURCHASE_LEDGER_WINDOW_MS),
        },
        detail: { path: ["purchaseKeyHash"], equals: purchaseKeyHash },
      },
      select: { id: true },
    });
    if (prior) {
      throw new ApiError(
        409,
        "この候補の謄本は最近取得済み（または請求済み）です。添付を確認するか、登記情報提供サービスのマイページで請求状態を確認してください",
        "REGISTRY_PURCHASE_ALREADY_DONE",
      );
    }
  }

  // 5. 楽観ロック取得: version 一致 かつ まだ scheduled でない物件だけを scheduled にする。
  //    count===0 は並行取得 or バージョン変化 → 409（二重実行させない）。
  const previousStatus = property.registryStatus;
  const lock = await prisma.property.updateMany({
    where: {
      id: propertyId,
      version: property.version,
      registryStatus: { not: "scheduled" },
      // @codex P2: 所在検索取得は「検索キー項目（指紋）」も一致条件に含め、read〜lock の間に
      //   version を上げない経路（取込・PDF処理等）で編集されていても lock を失敗させる。
      //   これで override（resolve 時の番号）は「lock した行の指紋 = resolve 時の指紋」の時だけ使う。
      // ⚠**回収(候補なし)も同じ扱いにする**(@codex #394 R24 P1)。確認時点の検査を
      //   通っても、その後に version を上げない経路(CSV取込の重複更新など)で所在や
      //   地番が変わると、**別の対象になった物件**にPDFと所有者情報を貼ってしまう。
      //   取得キーに使う項目をロック条件に入れ、変わっていたら lock を失敗させる。
      ...(args.expectedFingerprint !== undefined || (isRecover && !args.locationCandidate)
        ? {
            address: property.address,
            lotNumber: property.lotNumber,
            buildingNumber: property.buildingNumber,
            realEstateNumber: property.realEstateNumber,
          }
        : {}),
      // @codex #399 R5 P2: **課金するときだけ**、承認時に警告が無かった項目を
      //   このロックと同じ一文で検査する。別の問い合わせで確かめると、相手の
      //   未確定な処理（謄本PDFの添付・所有者の紐付け）を読み落とし、
      //   **既にある謄本をもう一度買う**。物件配下の書き込みは親行を先にロックする
      //   規約なので、相手が押さえている間はここで待たされ、確定後に評価し直される。
      // ⚠回収(課金なし)には掛けない。買った書類の取り込みは重複と無関係。
      ...(willPurchaseByLocation
        ? buildApprovedDuplicateGuard(args.approvedPreflight)
        : {}),
    },
    data: { registryStatus: "scheduled", version: { increment: 1 } },
  });
  if (lock.count === 0) {
    // ⚠**重複で弾いたのかを先に見分ける**(@codex #399 R5 P2)。「実行中です」と言われると
    //   利用者は待って押し直すが、実際は**もう持っている**のだから、待っても解決しない。
    if (willPurchaseByLocation && args.approvedPreflight) {
      const now = await prisma.property.findUnique({
        where: { id: propertyId },
        select: {
          registryStatus: true,
          _count: { select: { propertyOwners: true } },
        },
      });
      const attachedNow = await prisma.attachment.count({
        where: {
          targetType: "property",
          targetId: propertyId,
          type: "registry",
          isDeleted: false,
        },
      });
      const appearedObtained =
        !args.approvedPreflight.registryObtained &&
        now?.registryStatus === "obtained";
      const appearedAttachment =
        !args.approvedPreflight.hasRegistryAttachment && attachedNow > 0;
      const appearedOwners =
        !args.approvedPreflight.hasOwners && (now?._count.propertyOwners ?? 0) > 0;
      if (appearedObtained || appearedAttachment || appearedOwners) {
        throw new ApiError(
          409,
          "確認のあとに、この物件の謄本が登録されました。課金していません。画面を開き直して内容を確かめてください",
          "REGISTRY_PURCHASE_DUPLICATE_APPEARED",
        );
      }
    }
    // 候補取得で lock 失敗 = 並行取得 or 検索キー項目の変化。指紋が今も一致するか再確認して弁別する。
    if (args.expectedFingerprint !== undefined) {
      const fresh = await prisma.property.findUnique({
        where: { id: propertyId },
        select: {
          address: true,
          lotNumber: true,
          buildingNumber: true,
          realEstateNumber: true,
        },
      });
      if (!fresh || fingerprintProperty(fresh) !== args.expectedFingerprint) {
        throw new ApiError(
          409,
          "物件情報が変わりました。もう一度検索してから取得してください",
          "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
        );
      }
    }
    throw new ApiError(
      409,
      "この物件は既に謄本自動取得を実行中です",
      "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    );
  }

  // 6. provider 取得 → PDF 検証 → text 抽出 → processRegistryPdf 接続 → 成功 status。
  //    いずれの失敗でも scheduled で固着させないよう、catch で必ずロック解除する。
  try {
    // 取得キーは非PIIのみ（realEstateNumber / 物件UUID）。所有者名は渡さない。
    // cond③: 所在検索の候補取得では server 再解決した override を優先（物件は番号未保持）。
    // 段階②: 地番候補の有料取得は location を渡す（番号があれば番号を優先）。
    const effectiveNumber = args.realEstateNumber ?? property.realEstateNumber;
    if (isRecover) {
      // 回収は provider 側の専用メソッド(課金操作を含まない実装)でのみ行う。
      if (!provider.recoverRegistryPdf) {
        throw new ApiError(
          501,
          "この環境では取得済みの書類の取り込みに対応していません",
          "REGISTRY_RECOVER_NOT_SUPPORTED",
        );
      }
    }
    const fetchOne = isRecover
      ? provider.recoverRegistryPdf!.bind(provider)
      : provider.fetchRegistryPdf.bind(provider);
    const fetchResult = await fetchOne({
      // ⚠回収は**番号を渡さない**(提出前レビュー指摘)。番号が入っていると、
      //   provider 実装の「番号があれば番号を優先」に乗って**課金フロー**
      //   (確定→請求)へ落ちる余地が残る。回収は所在だけで引く。
      realEstateNumber: isRecover ? null : effectiveNumber,
      location:
        (isRecover ? recoverLocation : args.locationCandidate) &&
        (isRecover || !effectiveNumber?.trim())
          ? {
              address: property.address ?? "",
              lotNumber: (isRecover ? recoverLocation : args.locationCandidate)!
                .lotNumber,
              buildingNumber: (isRecover
                ? recoverLocation
                : args.locationCandidate)!.buildingNumber,
              // ⚠鍵(purchaseKeyHash)と同じ選択値を使う(上で確定した certificateType)。
              certificateType,
              // 【回収】区域キーを作るときに末尾から外してよい候補(物件行の実値)。
              // 候補経由の建物取得は地番を持たないため、ここで補う(@codex R12 P2)。
              ...(isRecover
                ? {
                    addressIdentifiers: [
                      property.lotNumber,
                      property.buildingNumber,
                    ],
                  }
                : {}),
            }
          : null,
      ref: property.id,
      // 実況(あれば)。文字は固定文言のみ・撮影はストア側で本人限定(検索と同じ)。
      live: args.live,
    });

    // processRegistryPdf の結果は inner try の外(成功ログ/返却)でも使うため先に宣言する。
    let result: Awaited<ReturnType<typeof processRegistryPdf>>;

    // ⚠**課金境界(provider 返却)を越えた後の失敗はすべて charged_but_failed に統一**する
    // (@codex #361 P1)。以降の PDF検証(422)・抽出(422)・processRegistryPdf の ApiError・
    // Prisma 例外を**生のまま**投げると、呼び出し側(単発 route / 一括取得)が「未課金の失敗」と
    // 誤分類し、一括では次の有料取得へ進んでしまう。ledger 書き込み失敗・添付なしガードの
    // RegistryFetchError("charged_but_failed") は既に正しいのでそのまま通す。
    try {
      // ⚠台帳は provider が返った**直後**に書く(@codex #345 P1)。ここまで来た時点で
      // 課金は済んでいる。後段(PDF検証・抽出・添付)で失敗しても台帳が無いと、
      // 再実行で**同じ謄本にもう一度課金**できてしまう。
      // ⚠writeAuditLog は**使わない**(@codex R3 P1): あれは内部で失敗を握りつぶし
      // mockモードでは何も書かない=「唯一の30日マーカー」が黙って消え得る。
      // 台帳は監査ではなく**正しさの根拠**なので、throw する直書き(prisma)で永続を
      // 確認する。書けなければ処理を止め(添付はしない)、charged_but_failed へ
      // 変換して catch 側の再試行+ロック保持の防御に入る。
      if (purchaseKeyHash) {
        try {
          await prisma.auditLog.create({
            data: {
              userId: session.id,
              action: REGISTRY_PURCHASE_AUDIT_ACTION,
              targetTable: "properties",
              targetId: propertyId,
              detail: { purchaseKeyHash, outcome: "charged", certificateType },
            },
          });
        } catch {
          console.warn(
            "[registry-fetch] CRITICAL: charged but ledger persist failed; aborting before attach",
          );
          throw new RegistryFetchError("charged_but_failed");
        }
      }

      // ⚠**貼る直前にもう一度、対象が同じ物件のままかを確かめる**(@codex #394 R26 P1)。
      //   ロックの一致条件は updateMany の**その瞬間**しか効かない。数分かかる取得の
      //   最中に、scheduled を見ない・version を上げない経路(CSV取込の重複更新)で
      //   所在や地番が変わると、**別の対象になった物件**にPDFと所有者情報を貼る。
      //   ⚠回収は課金していないので、ここで中止しても失うものは無い(やり直せる)。
      if (isRecover) {
        const fresh = await prisma.property.findUnique({
          where: { id: propertyId },
          select: {
            address: true,
            lotNumber: true,
            buildingNumber: true,
            realEstateNumber: true,
          },
        });
        if (
          !fresh ||
          fresh.address !== property.address ||
          fresh.lotNumber !== property.lotNumber ||
          fresh.buildingNumber !== property.buildingNumber ||
          fresh.realEstateNumber !== property.realEstateNumber
        ) {
          throw new ApiError(
            409,
            "取り込みの途中で物件情報が変わりました。画面を開き直してからもう一度お試しください",
            "REGISTRY_RECOVER_PROPERTY_CHANGED",
          );
        }
      }

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
      result = await processRegistryPdf({
        session,
        text,
        propertyId,
        fileName: fetchResult.fileName,
        edited: undefined,
        pdfBuffer: fetchResult.pdfBuffer,
        // 有料取得の種別を渡す。all のときは所有者を反映せず、添付に種別ラベルを付ける。
        certificateType,
      });

      // ⚠**有料取得は「PDFの添付」が成果物**。保存に失敗していたら成功にしない
      // (@codex #360 P1)。processRegistryPdf は保存失敗を warning に握りつぶして
      // attachmentId を返さない。有料購入なのにここが空だと、
      //   - all: 所有者反映もしないので**払ったのに物件に何も残らない**
      //   - owner: 所有者は反映されるが**買ったPDF自体は失われる**
      // まま obtained にして成功表示され、台帳は30日再取得をブロックする。
      // 課金境界の後なので **charged_but_failed** として下の catch に処理させる
      // (台帳記録+ロック維持+マイページ確認の案内)。
      if (purchaseKeyHash && !result.attachmentId) {
        throw new RegistryFetchError("charged_but_failed");
      }
      // 回収も成果物はPDFの添付。保存できていなければ成功にしない。
      // ⚠ただし**課金していない**ので charged_but_failed には**しない**
      // (利用者に「お金が動いたかも」と誤警告しないため)。
      if (isRecover && !result.attachmentId) {
        throw new ApiError(
          422,
          // ⚠やり直せることは伝えるが、**取込の記録が重複し得る**ことも隠さない
        //   (@codex #394 R6 P2: 保存の前段(取込記録・物件の項目・所有者)は既に
        //   確定しているため、再実行は同じPDFをもう一度取り込む)。
        "取得済みの謄本を保存できませんでした。物件の添付をご確認ください(やり直せますが、取込の記録が重複することがあります)",
          "REGISTRY_RECOVER_ATTACH_FAILED",
        );
      }

      // 成功 → scheduled から obtained へ確定。
      await prisma.property.update({
        where: { id: propertyId },
        data: { registryStatus: "obtained", version: { increment: 1 } },
      });
    } catch (postErr) {
      // 課金境界を越えた後の失敗=charged_but_failed に変換して外側 catch へ委ねる
      // (台帳記録+ロック維持+マイページ確認の案内)。既に charged_but_failed 等の
      // RegistryFetchError ならそのまま(二重変換しない)。無料経路(purchaseKeyHash なし)は
      // 元のエラーを保つ(お金は動いていない)。
      if (purchaseKeyHash && !(postErr instanceof RegistryFetchError)) {
        throw new RegistryFetchError("charged_but_failed");
      }
      throw postErr;
    }

    // 台帳は provider 返却直後に outcome:"charged" で記録済み(@codex #345 P1)。
    // ここでの追記は不要(照合は purchaseKeyHash のみで行い outcome は見ない)。

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
        // お金の記録の読み分け: purchase=今回買った / recover=買ってあった物の取り込み。
        mode: isRecover ? "recover" : "purchase",
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
    // 段階②: **課金後の失敗は、ロックを解除する前に台帳へ残す**(@codex #345 R2 P1)。
    // 解除が先だと「ロック無し×台帳無し」の隙間ができ、その間に同じ候補の再実行が
    // 通って**もう一度課金**できてしまう。
    // ⚠さらに(@codex R3 P1): 台帳が**書けなかった場合はロックを解除しない**。
    // 「台帳無し×ロック無し」は再課金可能な状態そのもの。scheduled のまま残せば
    // 取得APIは 409 で止まり続ける(fail-closed)。解消は運用(状態の手動リセット)。
    let ledgerPersisted = true;
    if (purchaseKeyHash && err instanceof RegistryFetchError && err.code === "charged_but_failed") {
      try {
        // writeAuditLog は失敗を握りつぶすため使わない(直書きで永続を確認する)。
        await prisma.auditLog.create({
          data: {
            userId: session.id,
            action: REGISTRY_PURCHASE_AUDIT_ACTION,
            targetTable: "properties",
            targetId: propertyId,
            detail: {
              purchaseKeyHash,
              outcome: "charged_but_failed",
              certificateType,
            },
          },
        });
      } catch {
        ledgerPersisted = false;
        console.warn(
          "[registry-fetch] CRITICAL: charged-failure ledger persist failed; leaving property locked",
        );
      }
    }

    // 失敗 → ロック解除（previousStatus へ戻す）。best-effort・元のエラー優先。
    // ⚠課金済みで台帳が書けなかった場合だけは解除しない(上記 fail-closed)。
    if (ledgerPersisted) {
      await releaseSchedulingLock(propertyId, previousStatus);
    }

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
          mode: isRecover ? "recover" : "purchase",
          providerErrorCode: err.code,
          confirmed: true,
        },
      });
      throw new ApiError(
        PROVIDER_ERROR_STATUS[err.code],
        err.message,
        "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
        // ⚠元の分類コード(charged_but_failed / rate_limited 等)を消さずに渡す。
        // 一括取得の分類が code 文字列を変えずに安全に判定できるようにする(@codex #361 P1)。
        err.code,
      );
    }

    // それ以外（extract 失敗の ApiError(422) / processRegistryPdf の ApiError / Prisma 例外）は
    // そのまま再 throw して route の handleApiError に正規の HTTP を返させる。
    throw err;
  }
}
