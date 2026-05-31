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
  // 法人番号サマリ（公開情報の件数・集計。生の氏名/住所ではない）
  "corporateNumber",
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
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (Array.isArray(value)) {
    return value.map((el) => sanitizeValue(el, allow, forceSafe, depth + 1));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (forceSafe.has(k)) {
        // action 固有で危険キー判定を上書きして保持（例: rollback の fieldNames）。
        out[k] = sanitizeValue(v, allow, forceSafe, depth + 1);
      } else if (isDangerousKey(k)) {
        out[k] = REDACTED;
      } else if (allow.has(k)) {
        out[k] = sanitizeValue(v, allow, forceSafe, depth + 1);
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

  if (Array.isArray(detail) || isPlainObject(detail)) {
    return sanitizeValue(detail, allow, forceSafe, 0);
  }

  // detail 自体がプリミティブのケース（通常は object だが念のため）。
  if (typeof detail === "string") return REDACTED;
  return detail;
}
