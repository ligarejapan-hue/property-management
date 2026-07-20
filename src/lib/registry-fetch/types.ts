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
 * 取得対象の指定（非PII の検索キー）。
 * 実 provider が外部サービスへ問い合わせるための最小情報。所有者名・住所等の PII は含めない。
 */
export interface RegistryFetchRequest {
  /** 不動産番号（最も一意。あれば最優先で使用）。 */
  realEstateNumber?: string | null;
  /**
   * トレース用の非PII参照ラベル（例: ImportJobId / 物件UUID）。
   * 所有者名・住所等の PII を入れてはならない。
   */
  ref?: string | null;
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
  | "provider_error"
  // 登記情報提供サービスの利用時間外(jikangai.html へ誘導される)。auth_failed と区別し、
  // 利用者に「時間外」と明示する(誤って資格情報を疑わせない)。
  | "service_hours"
  // ログイン画面が得られない(サイト全体404等)が、時間外と断定できない場合。
  // 祝日夜(平日曜日だが18時閉局)はコード上判別できず、設定ミス/サイト側停止の可能性も
  // あるため「時間外」と断定せず可能性として案内する(@codex P2: 営業時間内の404を
  // 時間外と誤案内しない)。
  | "service_unavailable";

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
