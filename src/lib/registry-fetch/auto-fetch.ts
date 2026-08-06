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
  CANCEL_ACCEPTED_MESSAGE,
  CANCEL_IGNORED_CHARGED_MESSAGE,
  decideCancel,
} from "@/lib/registry-fetch/cancel-safety";
import {
  SHOZAI_DIALOG_BUTTON_SCOPE,
  looksLikeLotTail,
  matchDialogItemByPrefix,
  normalizeForMatch,
  type ShozaiDialogItem,
} from "@/lib/registry-fetch/shozai-dialog";
import {
  processRegistryPdf,
  type RegistryPdfSession,
} from "@/lib/registry-pdf/process";
import {
  RegistryFetchError,
  DEFAULT_CERTIFICATE_TYPE,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
  type RegistryCertificateType,
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
  searchResult: "#fudosanIchiranTbl", // [確定] 請求リスト(一覧)テーブル=ヒットの目印
  // ⚠ここから下は**段階②(有料の請求→PDF取得)専用**。段階②が配線されるまで
  //   どの経路からも押さない。理由: 「確定」は無料だが**カートに `未請求` の行を
  //   実際に作る**ので、請求→ダウンロードまで通せない状態で押すと、
  //   失敗するたびに御社のマイページへゴミ行が積み上がる(@codex #344 P1)。
  // ⚠2026-07-31 実サイト校正で是正した2件（旧値はどちらも実物と違っていた）:
  //   - 請求条件の送信 = 旧 `#myPageSeikyu`(実体はマイページ一覧の**課金**ボタン) → 下記
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
  locationDialogItem: '#kuikiDialogArea td[id^="GKuiki"]', // [確定] 区域の1件(td・onclick=GKuikiDialogFixed)
  locationDialogAllTab: "#btn-all", // [確定] 「全部」タブ(あかさたな絞り込みを使わない)
  // ⚠ダイアログの確定/戻る/取消は jQuery UI の buttonpane にあり **id を持たない**。
  //   文言で引く(ページ本体の「確定」= fuBtnForward とは**別物**なので取り違えない)。
  locationDialogButtonPane: ".ui-dialog-buttonpane button", // [確定] 確定/戻る/取消
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
  dialogOk: "#cbnDlgBtnOk", // [確定] ダイアログ確定(選んだ地番を親フォームへ反映・無料)
  // 請求事項(謄本種別)のチェックボックス群。2026-07-31 実サイト校正で確定。
  // ⚠ラジオではなく**チェックボックス**で、複数同時に請求できる形。
  // ⚠ON/OFF の実際の割り当ては種別で決まる=REGISTRY_CERTIFICATE_SELECTORS /
  //   certificateCheckboxPlan を正とする(ここは実要素の記録)。
  certificateAllCheck: "#fuAll", // [確定] 全部事項(certificateType=all で ON)
  certificateOwnerCheck: "#fuShoyusya", // [確定] 所有者事項(certificateType=owner で ON・既定)
  // マイページ(請求一覧)。課金とPDF取得はここで行う。
  myPageTab: "a[onclick*=\"selectTab('tabMy')\"]", // [確定] マイページタブ
  myPageTable: "#myPageTable", // [確定] 請求一覧テーブル
  myPageFilter: "#siborikomi", // [確定] 状態の絞り込み(すべて/未請求/請求済…)
  myPageSeikyuButton: "#myPageSeikyu", // [確定] **請求=課金**(状態が「未請求」の行のみ)
  myPageReloadButton: "#myReloadButton", // [要live] 一覧の「最新表示」(請求済への遷移を待つのに使う)
  myPageNextButton: "#myPageTable_next", // [確定] 一覧のページ送り(基準の完全性チェックに使う)
  myPagePrevButton: "#myPageTable_previous", // [確定] 一覧のページ戻し(再走査の先頭復帰に使う)
} as const;

/**
 * マイページ一覧の「所在」セルが対象の地番/家屋番号を指しているかの判定（段階②）。
 *
 * ⚠部分一致は禁物(@codex #345 P1): 「1-1」は「1-10」「11-1」の所在にも部分一致し、
 * **別の登記を課金してしまう**。所在セルは「地番区域＋地番」の形なので、
 * **正規化後に末尾一致**かつ**直前の文字が数字/ハイフンでない**（=地番の境界）ことを要求する。
 * ブラウザ内(evaluate)の判定と同じ規則。片方だけ直すと再発するため、単体テストは
 * この関数で行い、evaluate 内には同一ロジックを複製する(コメントで対で維持と明記)。
 */
export function registryRowMatchesChiban(
  cellText: string,
  normalizedTarget: string,
): boolean {
  const norm = normalizeChibanForDialog(cellText);
  if (normalizedTarget.length === 0) return false;
  if (!norm.endsWith(normalizedTarget)) return false;
  const prev = norm[norm.length - normalizedTarget.length - 1];
  return prev === undefined || !/[0-9-]/.test(prev);
}

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
async function isLocationRejectedByProvider(
  page: RegistryPageLike,
): Promise<boolean> {
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
async function selectPrefectureByLabel(
  page: RegistryPageLike,
  label: string,
): Promise<void> {
  const value = (await page.evaluate((arg: string) => {
    const [sel, want] = arg.split("|");
    const el = document.querySelector(sel) as HTMLSelectElement | null;
    if (!el) return "";
    const norm = (s: string) => s.replace(/\s+/gu, "").trim();
    const hit = Array.from(el.options).find(
      (o) => norm(o.textContent || "") === norm(want),
    );
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

  // 1) 都道府県を選ぶまでボタンは disabled。有効になるまで待ってから押す。
  await page.waitForFunction((arg: unknown) => {
    const b = document.querySelector(String(arg)) as { disabled?: boolean } | null;
    return !!b && b.disabled !== true;
  }, S.locationSelectButton);
  report("所在選択ダイアログを開いています…");
  await page.click(S.locationSelectButton);

  // 2) 中身は後から読み込まれる。「読み込み中・・・・」が消えるまで待つ。
  await page.waitForFunction(
    (arg: unknown) => {
      const [area, loading] = String(arg).split("|");
      const d = document.querySelector(area);
      if (!d || d.children.length === 0) return false;
      return !d.querySelector(loading);
    },
    `${S.locationDialogArea}|${S.locationDialogLoading}`,
  );

  // 3) 住所の残りを、**出てきた選択肢に前方一致**で当てながら1段ずつ進む。
  //    ⚠自前の規則(「市区町村郡」で切る)は使わない(@codex #358 P2)。
    //  「東村山市」「四日市市」のように区切り文字を名前の途中に含む自治体で
    //  壊れ、その住所が永久に検索できなくなる。正解はサイトの一覧が持っている。
  let remaining = normalizeForMatch(rest);
  while (remaining.length > 0) {
    const items = (await page.evaluate((sel: string) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => ({
        id: (el as { id?: string }).id || "",
        text: (el.textContent || "").trim(),
      }));
    }, S.locationDialogItem)) as ShozaiDialogItem[] | undefined;
    if (!items || items.length === 0) break; // これ以上の段が無い＝ここまでで確定

    const hit = matchDialogItemByPrefix(items, remaining);
    if (!hit && looksLikeLotTail(remaining)) {
      // ⚠**残っているのが地番なら、それは区域ではない**(@codex #358 P2)。
      // 区域を選び終えた後に数字だけ残るのは正常(地番は別の欄に入れる)。
      // ここで弾くと「丸の内1丁目1-1」のような普通の住所が通らなくなる。
      break;
    }
    if (!hit) {
      // ⚠**当てずっぽうで選ばない**。別の区域を選ぶと、利用者が意図しない
      // 土地の謄本を後段で請求してしまう。所在の指定として扱って中止する。
      // 選択肢の中身(地名)はログに出さない(PII 方針)。
      console.warn(
        "[registry-search] shozai dialog: no unique match, candidates=" +
          String(items.length),
      );
      await cancel();
      throw new RegistryFetchError("location_rejected");
    }
    const before = ((await page.evaluate((sel: string) => {
      return (document.querySelector(sel)?.textContent || "").trim();
    }, S.locationDialogSelectedPath)) ?? "") as string;

    await page.click("#" + hit.item.id);
    remaining = hit.rest;

    // 次の段が読み込まれるまで待つ。
    // ⚠**比較対象は「押す直前の階層表示」**(@codex #358 P1)。以前は
    // ブラウザ側に渡していない変数と比べていたため**常に真**になり、待たずに
    // 次の段へ進んでいた＝古い選択肢を読んで所在を弾いていた。
    // 待てない作りの場合もあるので、失敗しても続行して最後の「確定」で判定する。
    try {
      await page.waitForFunction(
        (arg: unknown) => {
          const { pathSel, loading, area, before: was } = JSON.parse(
            String(arg),
          ) as { pathSel: string; loading: string; area: string; before: string };
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
    console.warn("[registry-search] shozai dialog: fix button not enabled");
    await cancel();
    throw new RegistryFetchError("location_rejected");
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
          reportLive,
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
      const isBuilding = !!(
        input.buildingNumber && input.buildingNumber.trim().length > 0
      );
      const rawTarget = (
        (isBuilding ? input.buildingNumber : input.lotNumber) ?? ""
      ).trim();
      const targetKey = normalizeChibanForDialog(rawTarget);
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
        page
          .waitForFunction(() => false, undefined, { timeout: ms })
          .catch(() => {});

      // ---- 課金前ゾーン(①〜③: ナビゲーション+条件入力+ダイアログ検索) ----
      try {
        await page.waitForSelector(REGISTRY_SELECTORS.fudosanRequestLink, {
          state: "attached",
        });
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
        await page.fill(REGISTRY_SELECTORS.dialogChibanRangeStart, targetKey);
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

      // 課金対象として選んだマイページ行の行ID(列1)。状態待ち・再選択はこれに紐付ける
      // (@codex #345 R2 P1: 地番の再一致だけだと過去の行と取り違え得る)。
      let chargedRowId = "";
      // マイページ一覧の絞り込み(@codex #345 R5 P1)。基準・行選択は「未請求」だけに
      // 絞る=課金され得る行の全体集合を最小化し、ページ分割の可能性も下げる。
      // 値は option の表示ラベルで選ぶ(実 value は[要live]のため)。change を発火して
      // 一覧の再描画を促す(ハンドラ未接続でも後段のページ分割チェックが守る)。
      const applyMyPageFilter = (label: string) =>
        page.evaluate((json) => {
          const { filterSel, label } = JSON.parse(json) as {
            filterSel: string;
            label: string;
          };
          const el = document.querySelector(
            filterSel,
          ) as HTMLSelectElement | null;
          if (!el) return;
          const opt = Array.from(el.options).find(
            (o) => (o.textContent ?? "").trim() === label,
          );
          if (!opt) return;
          if (el.value !== opt.value) {
            el.value = opt.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, JSON.stringify({
          filterSel: REGISTRY_SELECTORS.myPageFilter,
          label,
        }));
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
      const myPageHasNext = () =>
        pagerEnabled(REGISTRY_SELECTORS.myPageNextButton);
      // ⚠「1ページに収まっている」は**前後どちらのページ送りも無効**であること
      // (@codex #345 R7 P1)。次ページだけ見ると、最終ページに居るとき(次=無効・
      // 前=有効)に単一ページと誤認し、先頭側の行が基準から漏れる。
      const myPageIsSinglePage = async (): Promise<boolean> =>
        !(await pagerEnabled(REGISTRY_SELECTORS.myPageNextButton)) &&
        !(await pagerEnabled(REGISTRY_SELECTORS.myPagePrevButton));
      // 再走査の前に一覧を先頭ページへ戻す(@codex #345 R6 P1)。前へボタンが有効な間
      // 押し戻す(最大10回)。戻さないと前回の走査で末尾ページに居座り、リロード後に
      // 先頭側へ挿入された行を**残りの全 attempt で見逃す**。
      const resetMyPageToFirst = async (): Promise<void> => {
        for (let i = 0; i < 10; i++) {
          if (!(await pagerEnabled(REGISTRY_SELECTORS.myPagePrevButton))) break;
          await page.click(REGISTRY_SELECTORS.myPagePrevButton);
          await sleep(800);
        }
      };
      // ⚠絞り込みは「掛けたつもり」を信用しない(@codex #345 R6 P1)。select が無い/
      // option が無い/非同期でまだ効いていない、のいずれでも「表示中の行=未請求の
      // 全体」という前提が崩れ、隠れていた残骸が確定後に「新規」へ化ける。
      // 検証は**結果そのもの**で行う: 選択中 option のラベル一致+読み込み中でない+
      // **表示中の全実データ行の状態列が「未請求」**。確認できなければ課金前に中止。
      const verifyPendingView = async (): Promise<boolean> => {
        for (let i = 0; i < 5; i++) {
          const okJson = (await page.evaluate((json) => {
            const { filterSel, tableSel, label } = JSON.parse(json) as {
              filterSel: string;
              tableSel: string;
              label: string;
            };
            const el = document.querySelector(
              filterSel,
            ) as HTMLSelectElement | null;
            // select 自体が無い=このページ状態では確認不能(hard)。
            if (!el) return JSON.stringify({ ok: false, hard: true });
            const opt = el.selectedOptions?.[0];
            if (!opt || (opt.textContent ?? "").trim() !== label) {
              return JSON.stringify({ ok: false, hard: false });
            }
            const t = document.querySelector(tableSel);
            if (!t) return JSON.stringify({ ok: false, hard: false });
            if (/データ取得中/.test(t.textContent ?? "")) {
              return JSON.stringify({ ok: false, hard: false });
            }
            const rows = Array.from(t.querySelectorAll("tbody tr")).filter(
              (tr) => tr.querySelectorAll("td").length >= 7,
            );
            for (const tr of rows) {
              const status = (
                tr.querySelectorAll("td")[5]?.textContent ?? ""
              ).trim();
              // 別状態の行が見えている=絞り込みが効いていない。
              if (status !== label) {
                return JSON.stringify({ ok: false, hard: false });
              }
            }
            return JSON.stringify({ ok: true, hard: false });
          }, JSON.stringify({
            filterSel: REGISTRY_SELECTORS.myPageFilter,
            tableSel: REGISTRY_SELECTORS.myPageTable,
            label: "未請求",
          }))) as string;
          const st = JSON.parse(okJson) as { ok: boolean; hard: boolean };
          if (st.ok) return true;
          if (st.hard) return false;
          await sleep(1200);
        }
        return false;
      };
      // ---- 課金前ゾーン(④: 対象行の特定と確定) ----
      try {
        try {
          await page.waitForSelector(REGISTRY_SELECTORS.dialogResultCheckbox, {
            state: "attached",
            timeout: DIALOG_RESULT_TIMEOUT_MS,
          });
        } catch (waitErr) {
          if (!isTimeoutError(waitErr)) throw waitErr;
          const loaded = await page.evaluate((sel) => {
            const t = document.querySelector(sel);
            return !!t && !/データ取得中/.test(t.textContent ?? "");
          }, REGISTRY_SELECTORS.dialogResultTable);
          if (!loaded) throw new RegistryFetchError("timeout");
          // 真の0件=検索時の候補が消えた(登記側の変化)。課金せず not_found。
          await domClick(REGISTRY_SELECTORS.dialogCancel).catch(() => {});
          throw new RegistryFetchError("not_found");
        }
        // 対象の地番セルを探して check(複数ページは searchByLocation と同じ防御で送る)。
        let found = false;
        for (let pageNo = 0; pageNo < MAX_DIALOG_PAGES; pageNo++) {
          const result = (await page.evaluate((json) => {
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
            const cells = Array.from(
              t.querySelectorAll('td[id^="cbnDlgChibanDt_"]'),
            );
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
          }, JSON.stringify({
            tableSel: REGISTRY_SELECTORS.dialogResultTable,
            target: targetKey,
          }))) as string;
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
            const c = document
              .querySelector(sel)
              ?.querySelector('td[id^="cbnDlgChibanDt_"]');
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
        await domClick(REGISTRY_SELECTORS.dialogOk);
        await sleep(1500); // 確定値のフォーム反映を待つ(ダイアログは閉じる)

        // ---- ⑤ 請求事項=**選んだ種別のみ**(検証つき・課金前) ----
        // 所有者事項(既定)/全部事項 のどちらか一方だけをONにし、残りは全部OFF。
        // 外し漏れ=追加課金なので、操作後に checked を読み戻して検証する。
        // disabled があり得る(#fuHeisaTokibo)ため DOM click で操作する。
        // ⚠on と off は種別から純関数(certificateCheckboxPlan)で導く=サイト初期状態の
        // 全部事項ONを、選んだ種別へ確実に反転させる。
        const certPlan = certificateCheckboxPlan(input.certificateType);
        const certJson = (await page.evaluate((json) => {
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
        }, JSON.stringify({
          onSel: certPlan.on,
          offSels: certPlan.off,
        }))) as string;
        const cert = JSON.parse(certJson) as {
          on: string;
          offResults: string[];
        };
        if (
          cert.on !== "ok" ||
          cert.offResults.some((r) => r !== "ok" && r !== "absent-ok")
        ) {
          // 種別を意図どおりに揃えられない → 課金前に中止(余計なものを買わない)。
          throw new RegistryFetchError("provider_error");
        }

        // ---- ⑥ 確定(無料)の**前に**既存行の行IDを控える(@codex #345 R2 P1) ----
        // 確定で作られる行を「確定前に無かった行」として同定する=**作成同一性**での紐付け。
        // 状態+地番だけの一致だと、過去の未請求残骸(exe運用等・実probeで実在確認)が
        // 1件だけ見えている時にそれへ課金してしまう。
        // ⚠一覧を「未請求」に絞り、**1ページに収まっている時だけ**進める
        // (@codex #345 R5 P1)。絞り込み・ページ分割で見えない行がある一覧は、
        // 基準としても選択対象としても不完全=残骸が「新規」に化ける余地になる。
        // 課金され得るのは未請求行だけなので、未請求に絞れば全体集合が最小になる。
        await applyMyPageFilter("未請求");
        if (!(await verifyPendingView())) {
          // 絞り込みが効いたことを確認できない=表示中の行を全体と見なせない。
          console.warn(
            "[registry-fetch] pending filter unverified; refusing before confirm (not charged)",
          );
          throw new RegistryFetchError("provider_error");
        }
        // ⚠先頭ページへ戻してから単一ページ判定(@codex R7 P1)。フィルタが既に
        // 「未請求」で最終ページに居ると applyMyPageFilter は no-op になり、
        // 次ページだけの判定では「最終ページ=単一ページ」と誤認する。
        await resetMyPageToFirst();
        if (!(await myPageIsSinglePage())) {
          console.warn(
            "[registry-fetch] my-page pending list is paginated; refusing before confirm (not charged)",
          );
          throw new RegistryFetchError("provider_error");
        }
        // ⚠基準は**全行のIDが読めた時だけ**成立(@codex #345 R4 P1)。読み込み中や
        // ID欠けの行を黙って落とすと present:true のまま不完全な基準になり、
        // 確定後にその行がIDを得て「新規」に見え、**残骸へ課金**し得る。
        // 一時的な読み込み中に備え、少し待って数回だけ再読する(ダメなら確定前に中止)。
        let prevRows: { present: boolean; ids: string[] } = {
          present: false,
          ids: [],
        };
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await sleep(1500);
          const prevRowsJson = (await page.evaluate((json) => {
            const { tableSel } = JSON.parse(json) as { tableSel: string };
            const t = document.querySelector(tableSel);
            if (!t) return JSON.stringify({ present: false, ids: [] });
            // 読み込み中の表は基準にしない(行が出そろっていない)。
            if (/データ取得中/.test(t.textContent ?? "")) {
              return JSON.stringify({ present: false, ids: [] });
            }
            // 実データ行(列が揃った行)のみ対象。空状態のプレースホルダ行は除く。
            const rows = Array.from(t.querySelectorAll("tbody tr")).filter(
              (tr) => tr.querySelectorAll("td").length >= 7,
            );
            const ids: string[] = [];
            for (const tr of rows) {
              const id = (
                tr.querySelectorAll("td")[1]?.textContent ?? ""
              ).trim();
              // ⚠IDが読めない行が1つでもあれば基準不成立(all-or-nothing)。
              if (!id) return JSON.stringify({ present: false, ids: [] });
              ids.push(id);
            }
            return JSON.stringify({ present: true, ids });
          }, JSON.stringify({
            probe: "row-ids",
            tableSel: REGISTRY_SELECTORS.myPageTable,
          }))) as string;
          prevRows = JSON.parse(prevRowsJson) as {
            present: boolean;
            ids: string[];
          };
          if (prevRows.present) break;
        }
        // ⚠基準が読めなければ**確定前に**中止(@codex #345 R3 P1)。基準なしで進むと
        // 「ちょうど1件」規則に落ち、既存の未請求残骸へ課金し得る。ここで止めれば
        // カート行も作られない(完全に無傷)。
        if (!prevRows.present) {
          console.warn(
            "[registry-fetch] my-page baseline unreadable; refusing before confirm (not charged)",
          );
          throw new RegistryFetchError("provider_error");
        }

        await domClick(REGISTRY_SELECTORS.requestConfirmButton);
        // 遷移先は請求リスト(#fudosanIchiranTbl)またはマイページ(#myPageTable) [要live]。
        await page.waitForSelector(
          `${REGISTRY_SELECTORS.searchResult}, ${REGISTRY_SELECTORS.myPageTable}`,
          { state: "attached", timeout: DIALOG_RESULT_TIMEOUT_MS },
        );
        await domClick(REGISTRY_SELECTORS.myPageTab);
        await page.waitForSelector(REGISTRY_SELECTORS.myPageTable, {
          state: "attached",
          timeout: DIALOG_RESULT_TIMEOUT_MS,
        });
        await sleep(1000);
        // 遷移でフィルタが既定に戻り得るため、選択フェーズも「未請求(検証つき)×1ページ」
        // を要求する(@codex R5/R6 P1)。満たさなければ課金前に中止(基準と同じ規則)。
        await applyMyPageFilter("未請求");
        if (!(await verifyPendingView())) {
          console.warn(
            "[registry-fetch] pending filter unverified at pick; refusing (not charged)",
          );
          throw new RegistryFetchError("provider_error");
        }
        // 選択フェーズも先頭復帰→前後無効の単一ページ判定(基準と同じ規則・@codex R7 P1)。
        await resetMyPageToFirst();
        if (!(await myPageIsSinglePage())) {
          console.warn(
            "[registry-fetch] my-page pending list is paginated at pick; refusing (not charged)",
          );
          throw new RegistryFetchError("provider_error");
        }
        // ⑦ 対象行の特定。新規行の描画が遅れることがあるため、見つからない間は
        // 最新表示をはさんで数回だけ再確認する(それでも無ければ課金せず中止)。
        let pick: { result: string; checkedCount?: number; rowId?: string } = {
          result: "not-found",
        };
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) {
            await domClick(REGISTRY_SELECTORS.myPageReloadButton).catch(
              () => {},
            );
            await sleep(2000);
          }
          const pickJson = (await page.evaluate((json) => {
            const { tableSel, target, prevPresent, prevIds } = JSON.parse(
              json,
            ) as {
              tableSel: string;
              target: string;
              prevPresent: boolean;
              prevIds: string[];
            };
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
            // 対象地番の判定は registryRowMatchesChiban と**同一規則を複製**(対で維持)。
            // ⚠部分一致は「1-1」が「1-10」に当たり別の登記を課金する(@codex #345 P1)。
            const hits = (cell: string): boolean => {
              const n = norm(cell);
              if (!n.endsWith(target)) return false;
              const prev = n[n.length - target.length - 1];
              return prev === undefined || !/[0-9-]/.test(prev);
            };
            // 列: 0=checkbox 1=行id 2=種別 3=詳細 4=所在 5=状態 6=日時 7=料金 8=PDF 9=期限
            const rows = Array.from(
              document.querySelectorAll(`${tableSel} tbody tr`),
            );
            const matches: { tr: Element; rowId: string }[] = [];
            for (const tr of rows) {
              const tds = tr.querySelectorAll("td");
              if (tds.length < 7) continue;
              const status = (tds[5]?.textContent ?? "").trim();
              const rowId = (tds[1]?.textContent ?? "").trim();
              if (status !== "未請求") continue;
              if (!hits(tds[4]?.textContent ?? "")) continue;
              // ⚠作成同一性(@codex R2 P1): 確定前から存在した行(過去の残骸)は対象外。
              // 基準(prevIds)が読めなかった場合はここへ到達しない(確定前に中止済み
              // =@codex R3 P1。prevPresent は防御的に残すが常に true)。
              if (!prevPresent) return JSON.stringify({ result: "no-baseline" });
              if (rowId && prevIds.includes(rowId)) continue;
              // 行IDが読めない行は同定できない=対象にしない(残骸かもしれない行を買わない)。
              if (!rowId) continue;
              matches.push({ tr, rowId });
            }
            if (matches.length === 0)
              return JSON.stringify({ result: "not-found" });
            if (matches.length > 1) {
              // 新規扱いの未請求が複数=どれを買うか確定できない。課金前に中止する。
              return JSON.stringify({
                result: "ambiguous",
                count: matches.length,
              });
            }
            // 既存の check をすべて外してから対象だけ check(他の行を巻き込んで課金しない)。
            for (const cb of Array.from(
              document.querySelectorAll(
                `${tableSel} tbody input[type="checkbox"]`,
              ),
            ) as HTMLInputElement[]) {
              if (cb.checked) cb.click();
            }
            const cb = matches[0].tr.querySelector(
              'input[type="checkbox"]',
            ) as HTMLInputElement | null;
            if (!cb) return JSON.stringify({ result: "no-checkbox" });
            if (!cb.checked) cb.click();
            const checkedCount = (
              Array.from(
                document.querySelectorAll(
                  `${tableSel} tbody input[type="checkbox"]`,
                ),
              ) as HTMLInputElement[]
            ).filter((c) => c.checked).length;
            return JSON.stringify({
              result: "checked",
              checkedCount,
              rowId: matches[0].rowId,
            });
          }, JSON.stringify({
            tableSel: REGISTRY_SELECTORS.myPageTable,
            target: targetKey,
            prevPresent: prevRows.present,
            prevIds: prevRows.ids,
          }))) as string;
          pick = JSON.parse(pickJson) as {
            result: string;
            checkedCount?: number;
            rowId?: string;
          };
          if (pick.result !== "not-found") break; // 見つからない時だけ再確認する
        }
        if (pick.result !== "checked" || pick.checkedCount !== 1) {
          // 対象行を1件に確定できない/複数選択になった → 課金前に中止。
          console.warn(
            "[registry-fetch] my-page row selection failed (not charged):",
            pick.result,
          );
          throw new RegistryFetchError("provider_error");
        }
        // 以降(状態待ち・再選択)は**この行ID**に紐付ける(地番の再一致より強い同定)。
        chargedRowId = pick.rowId ?? "";
      } catch (err) {
        if (err instanceof RegistryFetchError) throw err;
        console.warn(
          "[registry-fetch] paid flow pre-charge failed (not charged):",
          summarizeRegistrySearchError(err),
        );
        if (isTimeoutError(err)) throw new RegistryFetchError("timeout");
        throw new RegistryFetchError("provider_error");
      }

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

      // ---- ⑧ ここから課金。以降の失敗はすべて charged_but_failed ----
      try {
        // ⚠課金境界フラグ(@codex #345 P1)。押す**直前**に立てる=外側 timeout が
        // ここ以降で発火しても provider が charged_but_failed に分類できる。
        if (input.chargeState) input.chargeState.charged = true;
        await domClick(REGISTRY_SELECTORS.myPageSeikyuButton);
        // ⑨⑩ 課金した行が「請求済+PDF準備完了」になるのを待ち、**見つけたその場で**
        // 選択して DL へ進む(探索と選択を分けるとページ跨ぎで取り違え得る)。
        // 課金後はフィルタを「請求済」へ(課金した行が状態遷移後も見えるように)。
        // ⚠一覧はページ分割され得るため、行IDが見つからない時は次ページを最大10ページ
        // 探索する(@codex R5 P1)。課金後なので中止はせず、見つからなければ再試行→
        // 使い切ったら charged_but_failed(台帳は記録済み・マイページ確認を案内)。
        await applyMyPageFilter("請求済");
        let ready = false;
        for (let attempt = 0; attempt < 20 && !ready; attempt++) {
          await sleep(3000);
          // ⚠各走査は**先頭ページから**(@codex R6 P1)。前回の走査で末尾ページに
          // 居座ったままだと、リロード後に先頭側へ入った行を以降ずっと見逃す。
          await resetMyPageToFirst();
          for (let pageNo = 0; pageNo < 10; pageNo++) {
            const readyJson = (await page.evaluate((json) => {
              const { tableSel, target, rowId } = JSON.parse(json) as {
                tableSel: string;
                target: string;
                rowId: string;
              };
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
              // registryRowMatchesChiban と同一規則を複製(対で維持・部分一致禁止)。
              const hits = (cell: string): boolean => {
                const n = norm(cell);
                if (!n.endsWith(target)) return false;
                const prev = n[n.length - target.length - 1];
                return prev === undefined || !/[0-9-]/.test(prev);
              };
              const rows = Array.from(
                document.querySelectorAll(`${tableSel} tbody tr`),
              );
              // ⚠課金した行の**行ID**に紐付ける(@codex R2 P1)。行IDが取れなかった
              // 場合のみ、地番一致×最新日時のフォールバック。
              let best: { tr: Element; when: string } | null = null;
              for (const tr of rows) {
                const tds = tr.querySelectorAll("td");
                if (tds.length < 7) continue;
                const trId = (tds[1]?.textContent ?? "").trim();
                if (rowId ? trId !== rowId : !hits(tds[4]?.textContent ?? ""))
                  continue;
                const when = (tds[6]?.textContent ?? "").trim();
                if (!best || when > best.when) best = { tr, when };
              }
              if (!best) return JSON.stringify({ result: "not-found" });
              const tds = best.tr.querySelectorAll("td");
              const status = (tds[5]?.textContent ?? "").trim();
              const expiry = (tds[9]?.textContent ?? "").trim();
              // canDownloadRow と同一規則を複製(対で維持): 請求済+期限が**非空**+期間内。
              // 空の期限=PDF準備前(@codex R5 P2)。準備前にDLへ進むと失敗が
              // charged_but_failed で固定される。
              if (status !== "請求済" || expiry === "" || expiry === "期間超過") {
                return JSON.stringify({ result: "pending", status });
              }
              // 見つけたその場で選択まで済ませる(他の行の check は全て外す)。
              for (const cb of Array.from(
                document.querySelectorAll(
                  `${tableSel} tbody input[type="checkbox"]`,
                ),
              ) as HTMLInputElement[]) {
                if (cb.checked) cb.click();
              }
              const cb = best.tr.querySelector(
                'input[type="checkbox"]',
              ) as HTMLInputElement | null;
              if (!cb) return JSON.stringify({ result: "no-checkbox" });
              if (!cb.checked) cb.click();
              return JSON.stringify({ result: "ready" });
            }, JSON.stringify({
              tableSel: REGISTRY_SELECTORS.myPageTable,
              target: targetKey,
              rowId: chargedRowId,
            }))) as string;
            const st = JSON.parse(readyJson) as { result: string };
            if (st.result === "ready") {
              ready = true;
              break;
            }
            // pending(行は見えたが準備前)/no-checkbox → リロードして次の attempt へ。
            if (st.result !== "not-found") break;
            // not-found → 次ページを探索(無ければ break → リロードして次の attempt)。
            if (!(await myPageHasNext())) break;
            await page.click(REGISTRY_SELECTORS.myPageNextButton);
            await sleep(1200);
          }
          if (!ready) {
            await domClick(REGISTRY_SELECTORS.myPageReloadButton).catch(
              () => {},
            );
          }
        }
        if (!ready) {
          throw new RegistryFetchError("charged_but_failed");
        }
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
        now: deps.now,
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

  // 4.5 段階②(2026-07-31): 有料取得の**二重課金ガード(台帳)**。
  //     サイト側の歯止め(請求済は再請求不可)は「確定」のたびに新しいカート行ができるため
  //     アプリからの再実行には効かない。**アプリ側の台帳(AuditLog)を主**に、同じ
  //     物件×地番×種別 の購入(成功 or 課金後失敗)が直近にあれば実行前に止める。
  //     台帳に残すのは鍵の**ハッシュのみ**(地番=秘匿情報を監査に載せない)。
  // ⚠番号があれば番号取得(無料フローと同じ扱い)が優先され購入は起きない=台帳も見ない。
  let purchaseKeyHash: string | null = null;
  // ⚠**種別は1か所で確定させ、鍵と provider 請求の両方で同じ値を使う**。
  //   片方だけ owner に残すと all を買ったのに owner 鍵で照合し二重課金ガードが破れる。
  const certificateType: RegistryCertificateType =
    args.certificateType ?? DEFAULT_CERTIFICATE_TYPE;
  const willPurchaseByLocation =
    !!args.locationCandidate &&
    !(args.realEstateNumber ?? property.realEstateNumber)?.trim();
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
    const lotOrBuilding = (
      args.locationCandidate.lotNumber ??
      args.locationCandidate.buildingNumber ??
      ""
    ).trim();
    if (!lotOrBuilding || !(property.address ?? "").trim()) {
      // 買う対象(地番/家屋番号)か所在が無い候補は購入できない(課金前・fail-closed)。
      throw new ApiError(
        409,
        "選択した候補が見つかりません。物件情報が変わった可能性があります。もう一度検索してから取得してください",
        "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
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
    // 取得キーは非PIIのみ（realEstateNumber / 物件UUID）。所有者名は渡さない。
    // cond③: 所在検索の候補取得では server 再解決した override を優先（物件は番号未保持）。
    // 段階②: 地番候補の有料取得は location を渡す（番号があれば番号を優先）。
    const effectiveNumber = args.realEstateNumber ?? property.realEstateNumber;
    const fetchResult = await provider.fetchRegistryPdf({
      realEstateNumber: effectiveNumber,
      location:
        args.locationCandidate && !effectiveNumber?.trim()
          ? {
              address: property.address ?? "",
              lotNumber: args.locationCandidate.lotNumber,
              buildingNumber: args.locationCandidate.buildingNumber,
              // ⚠鍵(purchaseKeyHash)と同じ選択値を使う(上で確定した certificateType)。
              certificateType,
            }
          : null,
      ref: property.id,
    });

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
      // 有料取得の種別を渡す。all のときは所有者を反映せず、添付に種別ラベルを付ける。
      certificateType,
    });

    // 成功 → scheduled から obtained へ確定。
    await prisma.property.update({
      where: { id: propertyId },
      data: { registryStatus: "obtained", version: { increment: 1 } },
    });

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
    if (
      purchaseKeyHash &&
      err instanceof RegistryFetchError &&
      err.code === "charged_but_failed"
    ) {
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
