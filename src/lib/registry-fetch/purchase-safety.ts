/**
 * 謄本の**有料請求**まわりの安全機構（段階②）。
 *
 * この層が守るのは「お金」。取得の失敗はやり直せるが、**誤課金は取り返せない**ので、
 * 判断はすべてここに集約して単体で検証できる形にする。
 *
 * ## 実サイトの規則（2026-07-31 実測・deliverables/registry-calibration/stage2-flow-20260731.md）
 * 請求一覧の各行は状態を持ち、サイト側の JS が次を強制している:
 *  - **請求（課金）できるのは状態が「未請求」の行だけ**（「請求済」は再請求不可）
 *  - **PDF を取れるのは「請求済」かつ有効期限内**（「期間超過」は不可）
 *
 * ⚠サイト側の歯止めは**PDFの有効期限が切れると外れる**（期間超過なら再請求できてしまう）。
 * したがって二重課金の判定は**アプリ側を主**にし、サイト側の状態は多層防御として使う。
 *
 * ## 3つの防御はそれぞれ別の事故を防ぐ（重複ではない）
 * 1. **DBの楽観ロック**（既存 `runRegistryAutoFetch`: version + registryStatus + 指紋）
 *    … *同じ物件*への同時実行を止める。DB上にあるのでプロセスを跨いでも効く。
 * 2. **プロセス内の直列化**（本ファイル `runExclusivePurchase`）
 *    … *別々の物件*どうしの重なりを止める。登記サービスが**1IDにつき同時1セッション**
 *      なので、別物件でも並行すると後発が先発を強制ログアウトさせ、
 *      **先発は課金だけ済んでPDFを取り逃す**。DBロックでは物件が違うので防げない。
 * 3. **二重課金の鍵**（本ファイル `purchaseIdempotencyKey`）
 *    … *時間をおいた繰り返し購入*を止める。1・2 は同時実行しか見ないため、
 *      昨日買ったものを今日また買う事故はこれでしか防げない。
 *
 * ⚠2 は**同一プロセス内でのみ**有効。本番は `next start` の単一プロセス運用
 * （2026-07-31 実測: MainPID 1つ・next-server 1つ）なので現状は全体に効くが、
 * **将来サーバを複数台/複数ワーカーにするならDB側のロックへ移すこと**。
 */

/** 請求一覧の状態（実サイトの表示文字列）。未知の値は文字列のまま扱う。 */
export const REGISTRY_ROW_STATUS = {
  unrequested: "未請求",
  requested: "請求済",
  cancelled: "取消済",
  sizeError: "容量エラー",
  notFound: "該当なし",
} as const;

/** PDF 有効期限切れの表示。 */
export const REGISTRY_PDF_EXPIRED = "期間超過";

/**
 * その行に**課金してよいか**。サイト側 `myPageSeikyu()` と同じ判定。
 * ⚠「請求済」を true にしてはいけない（＝二重課金）。期限切れでの再請求は
 * 業務判断が要るので、この層では一律 false にして上位に委ねる。
 */
export function canChargeRow(status: string): boolean {
  return status.trim() === REGISTRY_ROW_STATUS.unrequested;
}

/**
 * その行から**PDFを取得してよいか**。サイト側 `myPageDownload()` と同じ判定に加え、
 * **期限が空でない**ことも要求する(@codex #345 R5 P2)。
 *
 * ⚠状態が「請求済」に変わっても PDF・期限のデータが入るまでに間があり得る。
 * 空の期限を「期限内」と読むと**準備前にダウンロードへ進んで失敗**し、
 * 課金境界の向こう側なので charged_but_failed(再実行不可)で固定されてしまう。
 * 期限が実際に入ってから=PDFが用意できてから、だけ true。
 */
export function canDownloadRow(status: string, pdfExpiry: string): boolean {
  const expiry = pdfExpiry.trim();
  return (
    status.trim() === REGISTRY_ROW_STATUS.requested &&
    expiry !== "" &&
    expiry !== REGISTRY_PDF_EXPIRED
  );
}

/**
 * 状態を人が読める理由文へ（利用者向けメッセージ用・非PII）。
 * 「なぜ取得できなかったか」を黙って握りつぶさないため。
 */
export function describeRowStatus(status: string): string {
  const s = status.trim();
  if (s === REGISTRY_ROW_STATUS.notFound) {
    return "登記情報提供サービスに該当する不動産がありませんでした";
  }
  if (s === REGISTRY_ROW_STATUS.cancelled) {
    return "この請求は取り消されています";
  }
  if (s === REGISTRY_ROW_STATUS.sizeError) {
    return "対象の登記情報が大きすぎて取得できません";
  }
  if (s === REGISTRY_ROW_STATUS.requested) {
    return "この物件は取得済みです";
  }
  return `想定外の状態のため中止しました（${s || "状態不明"}）`;
}

export interface PurchaseTarget {
  propertyId: string;
  /**
   * 地番 または 家屋番号。**物件の中でどの登記かを決める値**。
   * ⚠これが変わったら「別の登記を買う」＝別物として扱ってよい。
   */
  lotOrBuilding: string;
  /** 謄本種別（既定は所有者事項）。 */
  certificateType: string;
}

/**
 * 地番・家屋番号の表記を正規化する。
 *
 * ⚠**表記ゆれで別物と誤認すると二重課金になる**。登記の慣用表記（「1番1」「1の1」）と
 * ハイフン表記（「1-1」）、全角/半角、空白の違いを吸収して同一視する。
 */
function normalizeLotNumber(raw: string): string {
  return raw
    .normalize("NFKC") // 全角数字・全角記号 → 半角
    .replace(/[‐‑‒–—―ー−]/g, "-") // 各種ダッシュ・長音 → "-"
    .replace(/番地/g, "-") // ⚠「番」より先に処理（後だと「地」が残る）
    .replace(/[番号の]/g, "-") // 「1番1」「1の1」→「1-1」
    .replace(/\s+/g, "")
    .replace(/-+/g, "-") // 連続ハイフンを1つに
    .replace(/^-|-$/g, "") // 前後のハイフンを落とす（「1番地」→「1」）
    .toLowerCase();
}

/**
 * 二重課金防止の鍵。**同じ物件・同じ地番・同じ種別**は 1 件とみなす。
 *
 * ⚠**住所（所在）は鍵に含めない**（@codex #344 P2）。住所は物件編集でいつでも直せるため、
 * 「一丁目」→「1丁目」のような**表記の直しだけで鍵が変わり、二重課金の防止をすり抜ける**。
 * 物件そのものは `propertyId` で一意に決まり、その中のどの登記かは地番/家屋番号で決まるので、
 * 識別には**変わらない項目（propertyId）と、買う対象そのもの（地番・種別）**だけを使う。
 *
 * ⚠逆に「別の場所だと分かって物件の住所を直した」場合は、同じ地番でも別の登記になり得るが、
 * その時は地番も変わるのが通常。もし本当に同じ物件IDで別物を買い直す必要が出たら、
 * 「取得済み」を利用者に見せたうえで明示的に上書きさせる（黙って再課金しない）。
 */
export function purchaseIdempotencyKey(target: PurchaseTarget): string {
  const normType = (v: string) =>
    v.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return [
    target.propertyId,
    normalizeLotNumber(target.lotOrBuilding),
    normType(target.certificateType),
  ].join("|");
}

// ---------------------------------------------------------------------------
// 直列化（同時に2件請求しない）
// ---------------------------------------------------------------------------

/**
 * ⚠既存の throttle（開始間隔）だけでは重なりを防げない。1件の請求は
 * 「ログイン → 条件入力 → 確定 → 請求 → PDF」と長く、間隔を空けても後続が追いつく。
 *
 * さらに**登記サービスは1IDにつき同時1セッション**で、後から入ると先のセッションが
 * 強制ログアウトされる。並行させると**自分の請求を自分で切って、課金だけ済んで
 * PDFを取り逃す**という最悪の壊れ方になる。プロセス内で1件ずつに直列化する。
 */
let purchaseChain: Promise<unknown> = Promise.resolve();

export function runExclusivePurchase<T>(fn: () => Promise<T>): Promise<T> {
  // 直前が失敗しても後続は動かす（失敗で列が詰まらないよう both handler を渡す）。
  const result = purchaseChain.then(fn, fn);
  purchaseChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** テスト用。列を空に戻す。 */
export function __resetPurchaseChainForTest(): void {
  purchaseChain = Promise.resolve();
}

// ---------------------------------------------------------------------------
// 課金境界（ここから先は自動で再試行しない）
// ---------------------------------------------------------------------------

/**
 * **請求ボタンを押した後**の失敗を表す印。
 *
 * ⚠この印が付いた失敗を自動再試行すると、**課金済みなのにもう一度課金する**。
 * 上位（route / provider）は再試行せず、そのまま利用者へ返すこと。
 * 課金は済んでいる可能性があるため、文言も「取り直し」ではなく
 * 「マイページで状態を確認」を促す。
 */
export class RegistryChargedButFailedError extends Error {
  readonly charged = true;
  constructor(
    message: string,
    /** どの段で落ちたか（非PII・診断用）。 */
    readonly step: "await-requested" | "download" | "attach",
  ) {
    super(message);
    this.name = "RegistryChargedButFailedError";
  }
}

/** 自動再試行してよい失敗か。課金境界を越えていたら false。 */
export function isRetryableFailure(err: unknown): boolean {
  return !(err instanceof RegistryChargedButFailedError);
}
