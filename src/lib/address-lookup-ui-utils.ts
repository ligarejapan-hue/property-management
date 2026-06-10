/**
 * 住所補完 UI core の純粋ロジック（PR2）。
 *
 * UI/hook から副作用と分離した「判定・整形・状態遷移」だけをここに置き、
 * node 環境(testing-library 無)でも実ユニットテストできるようにする。
 * 外部 API・APIキーには一切触れない（候補取得は api-client wrapper 経由）。
 */
import type { AddressLookupCandidate } from "./address-lookup/types";

// ---------------------------------------------------------------
// 上書き方針（silent overwrite を禁止するための判定）
// ---------------------------------------------------------------

/** 住所欄が実質空（空白のみ含む）なら自動反映してよい。 */
export function shouldAutofillAddress(currentAddress: string): boolean {
  return currentAddress.trim() === "";
}

/** 住所欄に既存値があるとき＝自動反映せず上書き確認が必要。 */
export function needsOverwriteConfirm(currentAddress: string): boolean {
  return !shouldAutofillAddress(currentAddress);
}

// ---------------------------------------------------------------
// 候補件数の判定
// ---------------------------------------------------------------

/** 候補がちょうど 1 件（＝確認なしで反映できる単一候補）。 */
export function isSingleCandidate(
  candidates: readonly AddressLookupCandidate[],
): boolean {
  return candidates.length === 1;
}

/** 候補が複数（＝ユーザーの選択 UI が必要）。 */
export function requiresCandidateSelection(
  candidates: readonly AddressLookupCandidate[],
): boolean {
  return candidates.length > 1;
}

// ---------------------------------------------------------------
// 表示用ラベル
// ---------------------------------------------------------------

/** 7桁の郵便番号にハイフンを入れる（例: 1000005 → 100-0005）。それ以外はそのまま。 */
export function formatPostalCode(postalCode: string): string {
  return /^\d{7}$/.test(postalCode)
    ? `${postalCode.slice(0, 3)}-${postalCode.slice(3)}`
    : postalCode;
}

/** 候補の表示ラベル（郵便番号があれば 〒付き）。PII を増やさず addressLine を主に使う。 */
export function formatCandidateLabel(candidate: AddressLookupCandidate): string {
  const zip = candidate.postalCode
    ? `〒${formatPostalCode(candidate.postalCode)} `
    : "";
  return `${zip}${candidate.addressLine}`.trim();
}

// ---------------------------------------------------------------
// エラー分類
// ---------------------------------------------------------------

/**
 * UI が扱うエラー区分。
 *  - invalid_input    … INVALID_INPUT（郵便番号7桁不正 / 住所未指定 = route 400）
 *  - not_configured   … API_KEY_MISSING（NOT_CONFIGURED = route 503・住所補完未設定）
 *  - provider_error   … PROVIDER_UNAVAILABLE / PROVIDER_ERROR（UPSTREAM_ERROR = route 502）
 *  - unknown          … 上記に当てはまらない
 *
 * api-client の apiFetch は route の `error.code` を捨て `error.message` だけを Error に載せる。
 * そのため route 側の安定メッセージ（PR #164）で分類する（code が取れないことへの割り切り）。
 */
export type AddressLookupErrorKind =
  | "invalid_input"
  | "not_configured"
  | "provider_error"
  | "unknown";

export function classifyAddressLookupError(error: unknown): AddressLookupErrorKind {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("7桁") || message.includes("住所を指定")) {
    return "invalid_input";
  }
  if (message.includes("設定されていません")) {
    return "not_configured";
  }
  if (message.includes("応答取得に失敗")) {
    return "provider_error";
  }
  return "unknown";
}

// ---------------------------------------------------------------
// hook 状態の reducer（純関数＝単体テスト可能）
// ---------------------------------------------------------------

export interface LookupState {
  loading: boolean;
  error: AddressLookupErrorKind | null;
  candidates: AddressLookupCandidate[];
}

export const initialLookupState: LookupState = {
  loading: false,
  error: null,
  candidates: [],
};

export type LookupAction =
  | { type: "request" }
  | { type: "success"; candidates: AddressLookupCandidate[] }
  | { type: "failure"; error: AddressLookupErrorKind }
  | { type: "reset" };

export function addressLookupReducer(
  state: LookupState,
  action: LookupAction,
): LookupState {
  switch (action.type) {
    case "request":
      return { loading: true, error: null, candidates: [] };
    case "success":
      return { loading: false, error: null, candidates: action.candidates };
    case "failure":
      return { loading: false, error: action.error, candidates: [] };
    case "reset":
      return initialLookupState;
    default:
      return state;
  }
}

// ---------------------------------------------------------------
// stale response ガード
// ---------------------------------------------------------------

/**
 * 発行時の seq が現在の最新 seq と一致するか。
 * 後から解決した古い検索/取得が新しい状態を上書きしないために使う
 * （owner-link-modal の searchSeqRef + isLatestSearch と同じ考え方）。
 */
export function isLatestRequest(seq: number, currentSeq: number): boolean {
  return seq === currentSeq;
}
