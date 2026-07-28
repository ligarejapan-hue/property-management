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
import { fingerprintProperty } from "./candidate-cache";

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
  /**
   * @codex P2: override を使う所在検索取得での TOCTOU 防止。resolve が候補を確定した時点の物件指紋。
   * ここで version-lock する行の指紋がこれと一致しなければ 409（resolve〜取得の間の編集を弾く）。
   */
  expectedFingerprint?: string;
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
  service_hours: 503, // 利用時間外=一時的に利用不可(Service Unavailable)。
  service_unavailable: 503, // 接続不可(時間外の可能性)=同じく一時的利用不可。
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
  $$eval(
    selector: string,
    pageFunction: (elements: Element[]) => unknown[],
  ): Promise<unknown[]>;
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
  return Math.max(
    1000,
    Math.min(LOGIN_FORM_DETECT_MS, Math.floor(timeoutMs / 2)),
  );
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
export function resolveLoginStepDeadline(
  startedAt: number,
  timeoutMs?: number,
): number | null {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  // 予算が小さいときは余裕も比例縮小する (下限で外側を追い越さないため)。
  const margin = Math.min(
    LOGIN_CLASSIFY_MARGIN_MS,
    Math.max(1, Math.ceil(timeoutMs / 2)),
  );
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
export function remainingLoginStepMs(
  deadlineAt: number | null,
  now: number,
): number {
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
  searchSubmit: "#myPageSeikyu", // [要live] 請求実行/次へ
  searchResult: "#fudosanIchiranTbl", // [確定] 請求リスト(一覧)テーブル=ヒットの目印
  downloadButton: "#download-pdf", // [要live] PDFダウンロード
  // 所在検索: 実サイトは多段UI。直接入力モードでダイアログを避ける(堅牢)。
  searchMethodLocationRadio: "#fuSeikyuMethodSHOZAI", // [確定] 請求方法=所在 ラジオ
  locationTypeLandRadio: "#fuShozaiTypeTOCHI", // [確定] 種別=土地
  locationTypeBuildingRadio: "#fuShozaiTypeTATEMONO", // [確定] 種別=建物
  locationPrefectureSelect: "#fuTodofukenShozai", // [確定] 都道府県 プルダウン
  locationDirectInputCheck: "#fuShozaiChokusetuNyuryoku", // [確定] 所在の直接入力モード
  locationSearchAddress: "#fuChibanKuiki", // [確定] 所在(地番区域=市区町村以下)入力
  locationSearchLotBuilding: "#fuChibanKaoku", // [確定] 地番・家屋番号入力
  // 所在検索フロー(2026-07-17 本番probe確定)。所在→不動産請求→地番検索ダイアログ方式。
  fudosanRequestLink: "a[href*=\"menuClick('FUDOSAN')\"]", // [確定] 不動産請求リンク(=loggedInMenuLinkと同値)
  dialogChibanKaokuListButton: "#fuChibanKaokuIchiran", // [確定] 地番・家屋番号一覧(ダイアログを開く)
  dialogChibanTypeNumeric: "#cbnDlgChibanType0", // [確定] 地番種別=数字/ハイフンのみ
  dialogChibanRangeStart: "#cbnDlgSearchChibanStart", // [確定] 地番範囲(開始)
  dialogSearch: "#cbnDlgChibanSearch", // [確定] ダイアログ内検索(結果は非同期ロード)
  dialogResultTable: "#cbnDlgChibanCheckTbl", // [確定] 候補テーブル(非同期ロード)
  dialogResultCheckbox: "#cbnDlgChibanCheckTbl input[type=checkbox]", // [確定] 候補行チェックボックス
  dialogPageNext: "#cbnDlgBtnPageNext", // [確定] 候補一覧の次ページ(複数ページ時)
  dialogCancel: "#cbnDlgBtnCancel", // [確定] ダイアログ取消(課金しない閉じ方)
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
 * ログイン失敗の分類サマリを作る（運用診断ログ用）。エラー名 + メッセージ先頭行 +
 * Playwright call log の最初の "waiting for ..." 行（あれば）。先頭行だけでは
 * 「page.fill: Timeout 30000ms exceeded.」のように **どのセレクタで** 詰まったかが journal から
 * 読めず、実障害（2026-07-17 ページ期限切れ）で切り分けに再調査を要した。
 * secret（loginId/password の実値）は Playwright エラーに載らない想定だが、防御的に除去する。
 * PII は含めない（このエラー経路のメッセージはセレクタ名/URL/TimeoutError 程度で、所有者名等は含まない）。
 */
export function summarizeRegistryLoginError(
  err: unknown,
  secrets: string[] = [],
): string {
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
 * 地番/家屋番号を、地番検索ダイアログの「数字・ハイフンのみ」欄(#cbnDlgChibanType0 +
 * #cbnDlgSearchChibanStart)が受理する形へ正規化する(@codex P1)。リポジトリの通常表記
 * (pdf-registry-parser 由来の「1番1」「1937番31」や全角「１－１」)をそのまま数字専用欄へ
 * 渡すと弾かれ候補ゼロになるため、全角数字→半角・「番(地)」→ハイフン・各種ダッシュ→半角
 * ハイフンに変換し、数字/ハイフン以外を除去する。純関数(テスト可能)。
 * 区切り「番(地)」「の(ノ)」はハイフンへ変換する(@codex P2)。「の」は registry-address-cleanup が
 * 地番/家屋番号の区切りとして認識する形式(例「1番2の3」)で、除去して隣接数字を連結すると別物件に
 * なるため、除去前にハイフン化する。
 * 例: 「1番1」→「1-1」/「1937番31」→「1937-31」/「1番2の3」→「1-2-3」/「５番」→「5」/「１－１」→「1-1」。
 */
export function normalizeChibanForDialog(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/番地|番|の|ノ/g, "-")
    .replace(/[‐‑‒–—―−ー－]/g, "-")
    .replace(/[^0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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
export function classifyRegistryMissingPage(
  now: Date,
): "service_hours" | "service_unavailable" {
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
          await page.waitForSelector(REGISTRY_SELECTORS.loginId, {
            timeout: formDetectTimeoutMs,
          });
        } catch (err) {
          if (isTimeoutError(err)) {
            const code = classifyRegistryMissingPage(new Date());
            // 運用診断: 開局帯でこれが出続ける場合はセレクタ/導線ドリフトの合図(非PII)。
            console.warn(
              "[registry-login] login form did not appear; classified as",
              code,
            );
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
        let sawForceLoginConfirm = false;
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
        if (unavailableNow === "closed")
          throw new RegistryFetchError("service_hours");
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
          const loginFormBack =
            submitted &&
            (await page
              .evaluate(
                (sel) => !!document.querySelector(sel),
                REGISTRY_SELECTORS.loginId,
              )
              .catch(() => false));
          if (!loginFormBack) {
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
          summarizeRegistryLoginError(err, [
            input.loginId,
            input.password,
            loginUrl,
            base,
          ]),
        );
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
        // 実サイトは請求画面で「請求方法=不動産番号」を選んでから番号を入力する。
        // ラジオ [確定]。番号入力欄/請求ボタンは番号モードの実操作画面で確定(=[要live])。
        await page.click(REGISTRY_SELECTORS.searchMethodNumberRadio);
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
    async searchByLocation(input) {
      // 実サイトの所在検索(2026-07-17 本番probe で全確定)。ログイン後の「請求情報受付メニュー」
      // には所在検索が無く、「不動産請求」画面へ遷移した先にある。さらに検索実行は「次へ」一発では
      // なく「地番・家屋番号一覧」ボタン→地番検索ダイアログ(非同期ロード)方式。段階①は候補一覧
      // (地番)を返すまでで **課金しない**: 確定(#cbnDlgBtnOk)・請求(#myPageSeikyu)は押さず、
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
      const isBuilding = !!(input.buildingNumber && input.buildingNumber.trim().length > 0);
      const rawKey = ((isBuilding ? input.buildingNumber : input.lotNumber) ?? "").trim();
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
      const reportLive = (label: string): void => {
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
              live.attachShot(
                seq,
                raw instanceof Uint8Array ? raw : new Uint8Array(raw),
              );
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
        if (prefecture) {
          await page.selectOption(
            REGISTRY_SELECTORS.locationPrefectureSelect,
            prefecture,
          );
        }
        await page.check(REGISTRY_SELECTORS.locationDirectInputCheck);
        await page.fill(
          REGISTRY_SELECTORS.locationSearchAddress,
          rest.length > 0 ? rest : input.address,
        );
        // 検索キーは種別に合わせた番号(建物=家屋番号 / 土地=地番)。
        if (searchKey.length > 0) {
          await page.fill(REGISTRY_SELECTORS.locationSearchLotBuilding, searchKey);
        }
        reportLive("所在と地番・家屋番号を入力しました");
        // 地番検索ダイアログを開く → 地番種別(数字/ハイフン) + 範囲 → 検索(非同期)。
        await page.click(REGISTRY_SELECTORS.dialogChibanKaokuListButton);
        await page.click(REGISTRY_SELECTORS.dialogChibanTypeNumeric);
        if (searchKey.length > 0) {
          await page.fill(REGISTRY_SELECTORS.dialogChibanRangeStart, searchKey);
        }
        reportLive("地番検索を実行しています…");
        await page.click(REGISTRY_SELECTORS.dialogSearch);
      } catch (err) {
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
          reportLive("候補は見つかりませんでした (0 件)");
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
          console.warn(
            "[registry-search] candidate pages capped at",
            MAX_DIALOG_PAGES,
          );
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
  //   未設定なら DEFAULT_REGISTRY_LOGIN_PATH（"/TeikyoUketsuke/"・実測確定）。非PII・非secret。
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
    return createPlaywrightRegistryPage(
      { browser, context, page },
      {
        loginPath,
        formDetectTimeoutMs: resolveLoginFormDetectMs(
          Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        ),
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      },
    );
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
  const browserFactory =
    options.browserFactory ?? resolveDefaultRegistryBrowserFactory();
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
  const locationSearchCalibrated =
    process.env.REGISTRY_FETCH_LOCATION_SEARCH_CALIBRATED === "true";
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
    throw new ApiError(
      403,
      "この物件にアクセスする権限がありません",
      "FORBIDDEN",
    );
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
      ...(args.expectedFingerprint !== undefined
        ? {
            address: property.address,
            lotNumber: property.lotNumber,
            buildingNumber: property.buildingNumber,
            realEstateNumber: property.realEstateNumber,
          }
        : {}),
    },
    data: { registryStatus: "scheduled", version: { increment: 1 } },
  });
  if (lock.count === 0) {
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
