/**
 * 謄本自動取得連携 — provider 抽象（PR3）。
 *
 * 外部の登記情報提供サービス等から謄本PDFを取得する処理を抽象化する interface。
 * 将来の `POST /api/properties/{id}/registry/auto-fetch` が provider を注入して呼び、
 * 取得した pdfBuffer を既存の手動取込コア（processRegistryPdf）に流し込む想定。
 *
 * 本 PR では **interface と mock provider のみ** を追加し、実 provider（外部接続・
 * Playwright・認証情報・課金・env）は一切実装しない。mock は外部I/Oに触れない。
 */

/**
 * 謄本の請求種別。サイトの実物にあるのは全部事項/所有者事項/地図/図面類で、
 * この機能で選べるのは有料の2種のみ（発注者確定・2026-08-05）:
 *  - "owner" = 所有者事項(既定・安い方。今までの固定値と同じ)
 *  - "all"   = 全部事項(権利関係まで載る・高い方)
 * ⚠この値は二重課金の鍵(purchaseIdempotencyKey)にも畳み込まれるため、鍵の生成と
 *   provider への請求で**必ず同じ値**を使う(片方だけ owner に残すと all を買ったのに
 *   owner 鍵で照合して二重課金ガードが破れる)。
 */
export type RegistryCertificateType = "owner" | "all";

/** 種別の既定値(発注者確定=所有者事項)。UI/route/args すべてこの既定に揃える。 */
export const DEFAULT_CERTIFICATE_TYPE: RegistryCertificateType = "owner";

/**
 * 取得対象の指定（非PII の検索キー）。
 * 実 provider が外部サービスへ問い合わせるための最小情報。所有者名・住所等の PII は含めない。
 */
export interface RegistryFetchRequest {
  /** 不動産番号（最も一意。あれば最優先で使用）。 */
  realEstateNumber?: string | null;
  /**
   * 所在検索の候補（地番/家屋番号）で取得する場合の入力（段階②・2026-07-31）。
   * 不動産番号を持たない物件は、所在＋地番で候補を選び**有料の請求→PDF取得**まで進む。
   * realEstateNumber と排他（両方あれば番号を優先）。値は秘匿情報＝log/監査/応答に出さない。
   */
  location?: {
    /** 所在（地番区域。例「千代田区丸の内一丁目」）。 */
    address: string;
    /** 地番（土地）。buildingNumber と排他で、どちらか一方は必須。 */
    lotNumber?: string | null;
    /** 家屋番号（建物）。 */
    buildingNumber?: string | null;
    /** 謄本種別（所有者事項=owner / 全部事項=all）。 */
    certificateType: RegistryCertificateType;
  } | null;
  /**
   * トレース用の非PII参照ラベル（例: ImportJobId / 物件UUID）。
   * 所有者名・住所等の PII を入れてはならない。
   */
  ref?: string | null;
  /**
   * 実況パネルのステップ通知先（任意・2026-08-15）。検索(RegistrySearchRequest.live)と
   * 同じ contract: label は**固定文言のみ**（所在・地番・資格情報を入れない）、非 throw、
   * 撮影は本体の await チェーンに乗せない。
   * ⚠有料取得は**中止を受け付けない**（課金だけ残る状態を作らない既存方針）。route は
   * begin 直後に cancel 窓を閉じてから渡す＝reporter に isCancelRequested を配線しない。
   */
  live?: RegistryLiveReporter;
}

/**
 * 取得成功結果。pdfBuffer は手動 multipart 取込と同じ Buffer で、そのまま
 * processRegistryPdf({ pdfBuffer, ... }) に渡せる形にする。
 */
export interface RegistryFetchResult {
  /** 取得した謄本PDFのバイト列。 */
  pdfBuffer: Buffer;
  /** 保存・監査用ファイル名（非PII）。 */
  fileName: string;
  /** 取得元 provider の識別子（非PII。例: "mock"）。 */
  source: string;
  /** 取得時刻。 */
  fetchedAt: Date;
  /**
   * provider 側リクエストの非PII識別子（監査/トレース用）。
   * APIキー・認証トークン・外部レスポンス本文・PII は含めない。
   */
  providerRequestId: string;
}

/**
 * provider エラーの分類コード（安全な enum）。
 * 外部レスポンス本文・認証情報・PII を含めず、この分類のみで上位へ伝える。
 */
export type RegistryFetchErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth_failed"
  | "not_found"
  // 所在の指定そのものが受け付けられなかった(2026-08-04 実機で判明)。
  // ⚠**候補ゼロと明確に区別する**。サイトは「請求できない所在です」と赤字で表示するのに、
  // こちらは候補チェックボックスの有無しか見ていなかったため「0件」と報告していた。
  // 例外を投げないので journald にも何も出ず、利用者にも開発側にも
  // **入力の問題だと分からない**(この機能で最も診断を困難にしていた原因)。
  | "location_rejected"
  // 利用者が実況パネルの「中止」を押して自分で止めた。⚠**失敗ではない**ので
  // 障害として扱わない(再試行を促さない)。課金前にしか発生しない。
  | "cancelled"
  | "provider_error"
  // 登記情報提供サービスの利用時間外(jikangai.html へ誘導される)。auth_failed と区別し、
  // 利用者に「時間外」と明示する(誤って資格情報を疑わせない)。
  | "service_hours"
  // ログイン画面が得られない(サイト全体404等)が、時間外と断定できない場合。
  // 祝日夜(平日曜日だが18時閉局)はコード上判別できず、設定ミス/サイト側停止の可能性も
  // あるため「時間外」と断定せず可能性として案内する(@codex P2: 営業時間内の404を
  // 時間外と誤案内しない)。
  | "service_unavailable"
  // ⚠段階②(有料取得): **請求(課金)ボタンを押した後**に失敗した。課金は発生している
  // 可能性がある。**自動でも手動でも安易に再実行してはいけない**(再実行=二重課金)。
  // 利用者にはマイページでの状態確認を案内する。
  | "charged_but_failed";

/**
 * 所在検索の入力（PR-2b）。所在/地番/家屋番号で謄本候補を検索する。
 *
 * 秘匿情報の扱い: 所有者PII（名前・住所）は含めない。ただし物件の所在地・地番・家屋番号は
 * 「秘匿情報（社内案件情報）」として扱い、log / AuditLog / error response に出してはならない
 * （= 呼び出し側 route / orchestration の責務。本 PR では型と seam のみ）。
 */
export interface RegistrySearchRequest {
  /** 所在（住所）。必須。秘匿情報。 */
  address: string;
  /** 地番（任意）。秘匿情報。 */
  lotNumber?: string | null;
  /** 家屋番号（任意）。秘匿情報。 */
  buildingNumber?: string | null;
  /** トレース用の非PII参照ラベル（例: 物件UUID）。PII・所在地は入れない。 */
  ref?: string | null;
  /**
   * 実況パネル (謄本自動操作のライブ中継) のステップ通知先 (任意)。
   * route が実行者本人限定のメモリ内 TTL ストア (live-view-store.ts) へ橋渡し
   * する。provider / adapter は label に秘匿情報 (所在・地番・資格情報) を
   * 入れない固定文言のみ渡す。shot (viewport スクショ) には所在等が写るため、
   * 閲覧はストア側で実行者本人に限定される。通知は best-effort であり、
   * 実装は例外を投げてはならない (検索本体を妨げない)。
   */
  live?: RegistryLiveReporter;
}

/**
 * 実況パネルへのステップ通知 (server 内のみで受け渡す callback。serialize しない)。
 *
 * 撮影は検索本体の await チェーンに乗せない (@codex R6: 実況を有効にした
 * だけで本体の timeout 予算を消費してはならない)。step は即時に文字だけを
 * 通知して seq を返し、スクショは fire-and-forget で撮って attachShot で
 * 後付けする。いずれも非 throw 契約 (best-effort)。
 */
export interface RegistryLiveReporter {
  /** ステップを即時通知する (label=固定文言・秘匿情報なし)。step の seq を返す (失敗は -1)。 */
  step(label: string): number;
  /** step() が返した seq へ viewport JPEG を後付けする (cap 超過・期限切れは黙って捨てる)。 */
  attachShot(seq: number, shot: Uint8Array): void;
  /**
   * 実況パネルの「中止」が押されたか。
   * ⚠provider は**節目ごとに**これを見て自分で止まる (外から処理を殺さない =
   * 外部サイトを中途半端な状態で放り出さない)。
   * ⚠**課金後は無視する** (判断は cancel-safety.ts)。
   * 実況を使わない呼び出し元もあるため任意。
   */
  isCancelRequested?(): boolean;
  /**
   * 中止を受け付ける期間の終わり (@codex #357 P2)。
   * ⚠**自動操作が終わった時点**で呼ぶ。以降は中止を見る場所がもう無いので、
   * 受け付けたままにすると「中止しています…」と表示したまま検索が完了し、
   * **止めたつもりなのに結果が出る**という食い違いが起きる。
   * 実況を使わない呼び出し元もあるため任意。
   */
  endCancelable?(): void;
}

/**
 * 所在検索の候補（PR-2b）。所有者PIIは含めない。
 *
 * 秘匿情報の扱い: address / lotNumber / buildingNumber / realEstateNumber は秘匿情報であり、
 * log / AuditLog / error response に出してはならない（呼び出し側の責務）。
 * candidateRef は provider 内部で候補を再解決するための非PII参照。**client から受け取った値を
 * そのまま信頼せず、取得時に server 側で当該物件向けに再解決する**（改ざん対策・PR-2b-2）。
 */
export interface RegistryCandidate {
  /** provider 内部の候補参照（非PII。取得時に server 側で再解決する）。 */
  candidateRef: string;
  /** 所在（秘匿情報・表示用）。 */
  address?: string | null;
  /** 地番（秘匿情報）。 */
  lotNumber?: string | null;
  /** 家屋番号（秘匿情報）。 */
  buildingNumber?: string | null;
  /** 不動産番号（秘匿情報・取得の最終キー）。 */
  realEstateNumber?: string | null;
}

/**
 * 謄本PDF取得 provider の抽象。実 provider（外部サービス接続）は将来差し替える。
 * 失敗時は RegistryFetchError（分類コードのみを持つ安全な例外）を throw する。
 */
export interface RegistryFetchProvider {
  /** provider の識別名（非PII。例: "mock"）。 */
  readonly name: string;
  /** 謄本PDFを取得する。失敗時は RegistryFetchError を throw。 */
  fetchRegistryPdf(request: RegistryFetchRequest): Promise<RegistryFetchResult>;
  /**
   * 所在/地番/家屋番号で謄本候補を検索する（PR-2b・任意実装）。
   * provider が検索に対応しない場合は未実装（optional）。失敗時は RegistryFetchError を throw。
   * 返す候補（秘匿情報）は呼び出し側が log / AuditLog / error response に出さない契約。
   */
  searchCandidates?(request: RegistrySearchRequest): Promise<RegistryCandidate[]>;
  /**
   * 所在検索（searchCandidates）が実際に利用可能かの宣言（PR-2b-2）。
   * searchCandidates メソッドが存在しても、実 adapter の searchByLocation が未実装の provider
   * （official・本 PR 時点）は true にしない。呼び出し側（runRegistrySearch）はこれが true の
   * ときだけ searchCandidates を呼ぶ。false / undefined で呼ぶと throttle/ブラウザを消費して
   * provider_error(502) になり、所在検索の fail-closed 501 を破るため（cond⑦）。
   */
  readonly supportsLocationSearch?: boolean;
}
