/**
 * 現地調査マップ Phase 1-G (Pin 作成 / 詳細 UI) 用の純粋 helper。
 *
 * - 副作用なし (fetch / localStorage / IndexedDB / navigator 等は呼ばない)
 * - lat / lng / accuracy / memo / API key / env / PII を console や戻り値に
 *   含めない
 * - 既存 server API (validators.ts) と整合: pinType allowlist は
 *   field-survey-constants から、status は API schema の PIN_STATUSES と一致
 */

import {
  FIELD_SURVEY_PIN_TYPES,
  type FieldSurveyPinType,
  isFieldSurveyPinType,
} from "@/lib/field-survey-constants";

export const FIELD_SURVEY_PIN_STATUSES = [
  "open",
  "closed",
  "archived",
] as const;
export type FieldSurveyPinStatus = (typeof FIELD_SURVEY_PIN_STATUSES)[number];

export function isFieldSurveyPinStatus(
  v: unknown,
): v is FieldSurveyPinStatus {
  return (
    typeof v === "string" &&
    (FIELD_SURVEY_PIN_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * Phase 1-G の pin type ラベル。Plan 承認済の固定文言。
 * 未知の値は受け取った文字列を素通し (UI 側で「不明」になる代わりに
 * 既存値が表示される)。
 */
export const PIN_TYPE_LABELS: Record<FieldSurveyPinType, string> = {
  candidate: "物件化候補",
  interesting: "要確認",
  blocked: "調査不可",
  followup: "再確認",
};

export function formatPinType(type: string): string {
  if (isFieldSurveyPinType(type)) return PIN_TYPE_LABELS[type];
  return type;
}

export const PIN_STATUS_LABELS: Record<FieldSurveyPinStatus, string> = {
  open: "未対応",
  closed: "対応済み",
  archived: "アーカイブ",
};

export function formatPinStatus(status: string): string {
  if (isFieldSurveyPinStatus(status)) return PIN_STATUS_LABELS[status];
  return status;
}

/**
 * Pin 詳細編集用 patch を組み立てる。変更が無いフィールドは省略し、
 * 全フィールド未変化なら null を返す (空 PATCH を打たないために呼び出し側で
 * null チェックする)。
 *
 * - memo は trim せずに「ユーザーが入力したまま」で比較する。null と "" の
 *   区別は API 側で許容 (`.optional().nullable()`)。
 * - 未知の pinType / status は schema が拒否するため、呼び出し側で UI 制御。
 */
export interface PinPatchDraft {
  pinType: string;
  status: string;
  memo: string | null;
}

export interface PinPatchBody {
  pinType?: string;
  status?: string;
  memo?: string | null;
}

export function buildPinPatch(
  original: PinPatchDraft,
  draft: PinPatchDraft,
): PinPatchBody | null {
  const out: PinPatchBody = {};
  if (draft.pinType !== original.pinType) out.pinType = draft.pinType;
  if (draft.status !== original.status) out.status = draft.status;
  if (!sameMemo(draft.memo, original.memo)) out.memo = draft.memo;
  return Object.keys(out).length === 0 ? null : out;
}

function sameMemo(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  // null と "" を別物として扱う (API zod は nullable / optional 両対応)。
  return false;
}

/**
 * Pin API のエラー status を座標 / 内部詳細を含まない汎用文言に変換する。
 * raw response body / message / code は使わない。
 */
export function pinApiErrorMessage(status: number): string {
  if (status === 401) return "ログインが必要です。再ログインしてください。";
  if (status === 403) return "権限がありません。";
  if (status === 404) return "対象の調査ピンが見つかりません。";
  if (status === 409) return "状態が変わりました。再読み込みしてください。";
  if (status === 422) return "入力内容に誤りがあります。";
  if (status >= 500 && status < 600) {
    return "サーバーエラーが発生しました。時間をおいて再試行してください。";
  }
  return "調査ピンの操作に失敗しました。";
}

/**
 * createdAt を「YYYY-MM-DD HH:MM」表記にする。
 * 不正値は空文字 (lat/lng / 内部値の流出回避のため例外送出しない)。
 */
export function formatPinCreatedAt(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export { FIELD_SURVEY_PIN_TYPES, isFieldSurveyPinType };
export type { FieldSurveyPinType };
