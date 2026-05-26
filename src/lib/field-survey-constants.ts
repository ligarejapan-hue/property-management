/**
 * 現地調査マップ (Phase 1) 用の定数。
 *
 * pinType は Prisma enum 化していない。app 層 allowlist で運用することで、
 * 将来の値追加時に migration を発生させず、後方互換性を保ちながら拡張できる。
 */

export const FIELD_SURVEY_PIN_TYPES = [
  "candidate",   // 物件化候補（更地・空き家など）
  "interesting", // 関心点（解体予定の張り紙など）
  "blocked",     // 立入不可・確認できなかった地点
  "followup",    // 再訪要・補足調査要
] as const;

export type FieldSurveyPinType = (typeof FIELD_SURVEY_PIN_TYPES)[number];

export function isFieldSurveyPinType(value: unknown): value is FieldSurveyPinType {
  return (
    typeof value === "string" &&
    (FIELD_SURVEY_PIN_TYPES as readonly string[]).includes(value)
  );
}

/**
 * 巡回 session の最大 memo 長 / pin memo の最大長。
 * Audit log への意図しない PII 流入を抑制するため上限を設ける。
 */
export const FIELD_SURVEY_MEMO_MAX_LEN = 2000;
