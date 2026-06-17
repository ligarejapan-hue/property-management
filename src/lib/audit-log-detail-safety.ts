/**
 * AuditLog.detail 返却/表示側の安全化（B / P1）。
 *
 * 目的: admin/audit-logs API が AuditLog.detail を素のまま返すことで、
 * 所有者名・住所・電話・メール・GPS座標・rawText/本文・token/apiKey/password/
 * secret/env 等が管理画面に過剰露出するのを防ぐ。
 *
 * 方針（保存側は変更しない・migration不要）:
 *  - allowlist 主体: 監査上明らかに安全なキー（ID・件数・状態・enum・boolean 等）だけ残す。
 *  - 許可されていないキーの値は再帰的に `[REDACTED]` へ置換する。
 *  - さらに denylist（危険キー）に当たるキーは allowlist より優先して必ず `[REDACTED]`。
 *  - 配列・ネスト object も再帰処理する。
 *  - unknown action は action 固有 allowlist を付与せず最も厳しく扱う。
 *  - detail 全体を null にはせず、安全情報は残す。
 *
 * 値そのものではなく「キー名」で判定する（保存値の中身は走査しない）。
 */

export const REDACTED = "[REDACTED]";

const MAX_DEPTH = 6;

/**
 * どの action でも残してよい、PII を含まない構造的キー。
 * ID / 件数 / 状態 / enum / boolean / フィルタ条件（PIIフリー）など。
 */
const ALWAYS_SAFE_KEYS: ReadonlySet<string> = new Set([
  // 識別子（UUID 等。名称・住所ではない）
  "id",
  "jobId",
  "importJobId",
  "rowId",
  "rowNumber",
  "rowNumbers",
  "propertyId",
  "ownerId",
  "buildingId",
  "userId",
  "targetId",
  "targetTable",
  "sourceOwnerId",
  "targetOwnerId",
  "createdId",
  // 件数・集計
  "count",
  "total",
  "totalRows",
  "resultCount",
  "successCount",
  "errorCount",
  "skipped",
  "skippedCount",
  "skippedMulti",
  "skippedConflict",
  "failed",
  "failedCount",
  "created",
  "createdCount",
  "updated",
  "updatedCount",
  // CSV import summary counters（実在キー: csv/route.ts の writeAuditLog detail）。
  // 非PIIの件数のみ。*Count を無条件許可せず実在キーに限定する。
  "updateCount",
  "needsReviewCount",
  "matched",
  "matchedCount",
  "detected",
  "saved",
  // 構造コンテナ（通過のみ許可。中の危険キーは常にマスクされる）
  "rows",
  "summary",
  "items",
  "results",
  "changes",
  "fields",
  // 更新監査の非PIIメタデータ（更新したフィールド名の配列。値ではない）。
  // 実在: properties/[id], bulk-update, actions, owners/[id], buildings/[id] 等の
  // detail.updatedFields は Object.keys(...) / fieldName 配列。oldValue/newValue/value は
  // allowlist 外なので引き続きマスクされる。
  "updatedFields",
  // 状態・種別・結果（enum / boolean / コード）
  "status",
  "action",
  "type",
  "jobType",
  "result",
  "reasonCode",
  "code",
  "dryRun",
  "confidence",
  "correctionType",
  "fileHash",
  // ページング・並び・フィルタ（PIIフリーな enum / 日付 / boolean）
  "page",
  "limit",
  "sortBy",
  "sortOrder",
  "includeArchived",
  "hasWarning",
  "filters",
  "propertyType",
  "registryStatus",
  "dmStatus",
  "caseStatus",
  "introductionRoute",
  "assignedTo",
  "updatedFrom",
  "updatedTo",
  "dateFrom",
  "dateTo",
  "exportedAt",
  // 法人番号サマリ系（件数・boolean のみ許可）。
  // 生値 corporateNumber は許可しない（audit_log:read で生の法人番号を返さない）。
  "corporateNumberCount",
  "corporateNumberMatchedCount",
  "corporateNumberHitCount",
  "corporateNumberAppliedCount",
  "hasCorporateNumber",
  // 派生長・ヒット数（生値ではなく長さ/件数のみ）
  "mgmtIdLen",
  "mgmtHitCount",
]);

/**
 * action 固有で追加許可するキー（allowlist へ合算）。
 * unknown action にはこれを付与せず ALWAYS_SAFE_KEYS のみで最も厳しく扱う。
 */
const ACTION_EXTRA_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  // 取込ロールバックの監査メタデータ（PIIではなく復元対象の構造情報・件数）。
  // 件数/状態系（*Count / blocked）は何件削除・復元・ブロックされたかの非PII監査情報。
  // allowlist のみ（force-safe ではない）ため unknown / 他 action では保持されない。
  import_job_rollback: new Set([
    "restoredFields",
    "fieldNames",
    "deletedCount",
    "restoredPropertyCount",
    "restoredFieldCount",
    "blocked",
  ]),
  // S1b-3: copy/cut/contextmenu/print 試行の監査。detail は非PII enum のみ
  //   surface = どの PII 画面か（owner/property/history/import/registry/dashboard）
  //   trigger = 操作の発生源（clipboard/menu/print_dialog/keyboard）
  // url/path/selectedText/ownerName 等は allowlist 外のため引き続き [REDACTED]。
  pii_copy_attempt: new Set(["surface", "trigger"]),
  pii_cut_attempt: new Set(["surface", "trigger"]),
  pii_contextmenu_attempt: new Set(["surface", "trigger"]),
  pii_print_attempt: new Set(["surface", "trigger"]),
  // 表示名監査（read-only レポート）の閲覧/CSV 出力監査。detail は操作事実の
  // 非PIIメタデータのみ（entity/format=enum・viewedAt=ISO日時・各種件数/真偽）。
  // owner-prefixed な件数/真偽（ownerGroupCount/ownerTruncated/ownerNameVisible）は
  // /owner/i denylist に当たるため、下の force-safe / numeric-force-safe で別途許可する。
  // 生 name / owner オブジェクト / 住所等の PII は allowlist 外 + denylist で引き続き [REDACTED]。
  display_name_audit_view: new Set([
    "entity",
    "format",
    "viewedAt",
    "buildingGroupCount",
    "buildingTruncated",
  ]),
  // 郵便番号照合レポート（read-only）の閲覧/CSV 出力監査。detail は操作事実の
  // 非PIIメタデータのみ（postal-code-audit route の writeAuditLog 参照）。
  // boolean フラグ（apiConfigured/truncated/timeBudgetExhausted）と構造コンテナ
  // summary だけを allowlist 化する。件数系（processed/notProcessed/maxTargets/
  // timeBudgetMs + summary 子の match/mismatch/indeterminate）は数値限定の
  // numeric-force-safe 側で許可する（非数値は PII 流入の恐れがあるため [REDACTED]）。
  // owner 名 / zip / address 等の PII は route 側で記録しないが、混入しても
  // allowlist 外 + denylist で引き続き [REDACTED]。
  postal_code_audit_list: new Set([
    "apiConfigured",
    "truncated",
    "timeBudgetExhausted",
    "summary",
  ]),
  postal_code_audit_csv_export: new Set([
    "apiConfigured",
    "truncated",
    "timeBudgetExhausted",
    "summary",
  ]),
  // DQ-03: 住所登記文字列 cleanup の監査メタデータ（非PII: 検出 type 配列・件数・boolean・
  // 結果コード・HTTP ステータス）。住所本文・検出文字列の生値は route 側で記録せず、
  // 混入しても allowlist 外 + denylist(/addr/i 等) で引き続き [REDACTED]。
  owner_registry_address_cleanup_preview: new Set([
    "detectedTypes",
    "removableTypeCount",
    "auditOnlyTypeCount",
    "manualReviewRequired",
  ]),
  owner_registry_address_cleanup_apply: new Set([
    "detectedTypes",
    "removableTypeCount",
    "manualReviewRequired",
    "httpStatus",
  ]),
  // 一覧 dry-run。summary は ALWAYS_SAFE コンテナだが、子キー cleanup/manual を再帰許可するため
  // ここにも登録する（total は ALWAYS_SAFE）。hasNextPage/truncated は非PIIメタデータ。
  owner_registry_address_candidates_list: new Set([
    "summary",
    "cleanup",
    "manual",
    "hasNextPage",
    "truncated",
  ]),
  // DQ-04: テキスト衛生（制御文字/文字化け）一覧 dry-run の監査メタデータ。すべて非PIIの
  // 数値カウンタ / boolean。summary は ALWAYS_SAFE コンテナだが、子キー（種別ごとの件数）は
  // 再帰でこの allowlist に照合されるためここに登録する（type / resultCount は ALWAYS_SAFE）。
  // 生値（name / address / note 等）は allowlist 外 + denylist で引き続き [REDACTED]。
  owner_text_hygiene_candidates_list: new Set([
    "summary",
    "hasNextPage",
    "truncated",
    "controlChars",
    "zeroWidth",
    "bidi",
    "replacementChar",
    "mojibake",
    "removableCandidates",
    "auditOnlyCandidates",
    "totalCandidates",
  ]),
  // 添付横断検索（GET /api/attachments/search）の非PII フィルタメタデータ。
  // targetType=対象種別(enum) / from・to=期間(ISO日付)。type / targetId / resultCount は
  // ALWAYS_SAFE。hasFileName は /name/i denylist ゆえ ACTION_FORCE_SAFE_KEYS 側で保持する。
  // 検索語（fileName 等）の生値は route 側で記録しないため対象外。
  attachment_search: new Set(["targetType", "from", "to"]),
  // registry_ocr_draft: OCR 下書き生成の非PII メタ（実行結果/件数のみ）。
  // raw OCR text・PDF 本文・氏名・住所等は route 側で一切載せない。
  registry_ocr_draft: new Set([
    "status",
    "pages",
    "charCount",
    "previewGenerated",
    "errorCode",
  ]),
  // 法人番号 一括反映: 件数のみ（owner.id 配列・法人番号・生値は載せない）。
  owner_correction_corporate_bulk_apply: new Set([
    "requested",
    "applied",
    "skipped",
  ]),
};

/**
 * action 固有で「危険キー判定を上書きして必ず保持する」キー（完全一致）。
 * 例: import_job_rollback の fieldNames は所有者名等のPIIではなく復元対象の
 * 「フィールド名」なので保持する。/name/i の一律判定をこのキーだけ上書きする。
 * ownerName / userName / fileName / name / address / email / phone 等は
 * ここに含めないため、rollback でも引き続き [REDACTED] になる。
 * unknown action には付与しないため fieldNames は安易に残らない。
 */
const ACTION_FORCE_SAFE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  import_job_rollback: new Set(["fieldNames"]),
  // display_name_audit_view の owner-prefixed な真偽メタデータ。/owner/i denylist に
  // 当たるが PII ではなく「owner 群を切り捨てたか / owner 名を生値表示できたか」の
  // boolean 監査情報。force-safe で保持する（値は boolean ゆえ PII 流入余地なし）。
  // ownerGroupCount（件数）は数値限定の numeric-force-safe 側で許可する。
  display_name_audit_view: new Set(["ownerTruncated", "ownerNameVisible"]),
  // attachment_search: hasFileName は /name/i denylist に当たるが「ファイル名フィルタを
  // 使ったか」の boolean ゆえ PII 流入余地なし。force-safe で保持する。
  attachment_search: new Set(["hasFileName"]),
};

/**
 * action 固有で「危険キー判定を上書きするが、値が有限数値のときに限り保持する」
 * キー（完全一致）。非数値が来た場合は PII 流入の恐れがあるため [REDACTED] にする。
 *
 * 例: pdf_import(謄本PDF取込) の owner 反映件数 ownersMatched/Created/Linked。
 * キー名に "owner" を含み /owner/i denylist に一致するが、有限数値(件数)のときだけ
 * 可視化する。owner 名/住所/郵便番号等の PII は依然 allowlist 外 + denylist で
 * [REDACTED]。unknown / 他 action では保持しない。
 */
const ACTION_NUMERIC_FORCE_SAFE_KEYS: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  pdf_import: new Set(["ownersMatched", "ownersCreated", "ownersLinked"]),
  // display_name_audit_view の owner 群件数。/owner/i denylist に当たるが有限数値
  // （群数）のときだけ保持する。非数値は PII 流入の恐れがあるため [REDACTED]。
  display_name_audit_view: new Set(["ownerGroupCount"]),
  // 郵便番号照合レポートの件数メタデータ。有限数値のときだけ保持する。
  // processed/notProcessed/maxTargets/timeBudgetMs はトップレベル、
  // match/mismatch/indeterminate は summary 子（同一 numericSafe 集合が再帰で
  // 全階層に適用される）。非数値が来た場合は PII 流入の恐れがあるため [REDACTED]。
  // （match は ALWAYS_SAFE だが numeric-force-safe が優先されるため、postal action
  //  では非数値 match も [REDACTED] になる＝防御の二重化。）
  postal_code_audit_list: new Set([
    "processed",
    "notProcessed",
    "maxTargets",
    "timeBudgetMs",
    "match",
    "mismatch",
    "indeterminate",
  ]),
  postal_code_audit_csv_export: new Set([
    "processed",
    "notProcessed",
    "maxTargets",
    "timeBudgetMs",
    "match",
    "mismatch",
    "indeterminate",
  ]),
};

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

/**
 * allowlist より優先して必ず `[REDACTED]` にする危険キーの「完全一致」集合
 * （小文字比較）。短いトークンは部分一致だと誤検知（template→lat 等）するため
 * 完全一致にする。
 */
const DANGEROUS_EXACT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "address",
  "addr",
  "owner",
  "email",
  "mail",
  "phone",
  "tel",
  "fax",
  "zip",
  "postal",
  "kana",
  "namekana",
  "note",
  "memo",
  "remarks",
  "keyword",
  "text",
  "body",
  "content",
  "html",
  "raw",
  "rawtext",
  "pdftext",
  "fulltext",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "env",
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "coordinates",
  "coords",
  "geo",
  "gps",
  "ip",
  "ipaddress",
  "ip_address",
  "useragent",
  "user_agent",
  "mgmtid",
  "mgmt_id",
]);

/**
 * 危険な複合キー（PII を含むことが明らかな語を含む）の部分一致パターン。
 * 完全一致では拾えない ownerName / userAddress / pdfText 等を捕捉する。
 * 誤検知を避けるため、十分に特徴的な語のみを部分一致対象にする。
 */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /name/i, // ownerName, userName, lastName, fileName 等（安全側で除去）
  /addr/i, // address, ownerAddress, addressLine
  /owner/i, // ownerName, coOwners 等
  /email/i,
  /mail/i,
  /phone/i,
  /passw/i, // password, passwd
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /accesskey/i,
  /credential/i,
  /rawtext/i,
  /pdftext/i,
  /fulltext/i,
  /latitude/i,
  /longitude/i,
  /coordinate/i,
  /postal/i,
];

function isDangerousKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (DANGEROUS_EXACT_KEYS.has(lower)) return true;
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(key)) return true;
  }
  return false;
}

function allowlistForAction(action: string | null | undefined): ReadonlySet<string> {
  if (!action) return ALWAYS_SAFE_KEYS;
  const extra = ACTION_EXTRA_KEYS[action];
  if (!extra) return ALWAYS_SAFE_KEYS;
  return new Set([...ALWAYS_SAFE_KEYS, ...extra]);
}

// action 固有で危険キー判定を上書きして保持するキー集合。
// unknown / 未登録 action では空集合（上書きなし）。
function forceSafeForAction(
  action: string | null | undefined,
): ReadonlySet<string> {
  if (!action) return EMPTY_KEY_SET;
  return ACTION_FORCE_SAFE_KEYS[action] ?? EMPTY_KEY_SET;
}

// action 固有で「有限数値のときに限り危険キー判定を上書きして保持する」キー集合。
// unknown / 未登録 action では空集合（上書きなし）。
function numericForceSafeForAction(
  action: string | null | undefined,
): ReadonlySet<string> {
  if (!action) return EMPTY_KEY_SET;
  return ACTION_NUMERIC_FORCE_SAFE_KEYS[action] ?? EMPTY_KEY_SET;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.prototype.toString.call(v) === "[object Object]"
  );
}

function sanitizeValue(
  value: unknown,
  allow: ReadonlySet<string>,
  forceSafe: ReadonlySet<string>,
  numericSafe: ReadonlySet<string>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (Array.isArray(value)) {
    return value.map((el) =>
      sanitizeValue(el, allow, forceSafe, numericSafe, depth + 1),
    );
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (numericSafe.has(k)) {
        // action 固有で危険キー判定を上書きするが、有限数値のときに限り可視化する
        // （非数値は PII 流入の恐れがあるため [REDACTED]）。例: pdf_import の owner 件数。
        out[k] = typeof v === "number" && Number.isFinite(v) ? v : REDACTED;
      } else if (forceSafe.has(k)) {
        // action 固有で危険キー判定を上書きして保持（例: rollback の fieldNames）。
        out[k] = sanitizeValue(v, allow, forceSafe, numericSafe, depth + 1);
      } else if (isDangerousKey(k)) {
        out[k] = REDACTED;
      } else if (allow.has(k)) {
        out[k] = sanitizeValue(v, allow, forceSafe, numericSafe, depth + 1);
      } else {
        out[k] = REDACTED;
      }
    }
    return out;
  }

  // プリミティブ: number / boolean / null は安全。
  // string は「許可キー配下」でのみここに到達するため、そのまま残す。
  return value;
}

/**
 * AuditLog.detail を action 別 allowlist + 危険キー denylist + 再帰マスクで安全化する。
 * 元のオブジェクトは変更せず、安全化したクローンを返す。
 *
 * - object: 許可キーのみ値を残し（さらに再帰）、それ以外は [REDACTED]。危険キーは常に [REDACTED]。
 * - array : 各要素を再帰処理。
 * - primitive（detail 自体が string 等）: number/boolean/null は残し、string は安全と判断できないため [REDACTED]。
 * - null / undefined: そのまま返す。
 */
export function sanitizeAuditDetail(
  action: string | null | undefined,
  detail: unknown,
): unknown {
  if (detail === null || detail === undefined) return detail;

  const allow = allowlistForAction(action);
  const forceSafe = forceSafeForAction(action);
  const numericSafe = numericForceSafeForAction(action);

  if (Array.isArray(detail) || isPlainObject(detail)) {
    return sanitizeValue(detail, allow, forceSafe, numericSafe, 0);
  }

  // detail 自体がプリミティブのケース（通常は object だが念のため）。
  if (typeof detail === "string") return REDACTED;
  return detail;
}
