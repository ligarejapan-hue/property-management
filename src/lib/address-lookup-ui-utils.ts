/**
 * 住所補完 UI core の純粋ロジック（PR2）。
 *
 * UI/hook から分離した「判定・整形・状態遷移」と、取得実行の DI コントローラ
 * （fetch/dispatch を ports として注入＝node 環境(testing-library 無)でも
 * 実ユニットテストできる）をここに置く。
 * 外部 API・APIキーには一切触れない（候補取得は hook が注入する api-client wrapper 経由。
 * このファイル自体は api-client を import しない）。
 */
import { debounce } from "./debounce";
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

// ---------------------------------------------------------------
// 取得実行コントローラ（hook から分離した DI 核＝node 環境で実挙動テスト可能）
// ---------------------------------------------------------------

/** 取得と dispatch の注入口。api-client は hook 側で注入し、このファイルは import しない。 */
export interface AddressLookupControllerPorts {
  fetchByPostalCode: (
    zip: string,
  ) => Promise<{ candidates: AddressLookupCandidate[] }>;
  fetchByAddress: (
    address: string,
  ) => Promise<{ candidates: AddressLookupCandidate[] }>;
  onAction: (action: LookupAction) => void;
}

export interface AddressLookupController {
  /**
   * 郵便番号 → 住所候補（明示操作・debounce なし）。保留中の住所検索は破棄する。
   * onSuccess は成功かつ最新（stale でない）のときだけ候補つきで呼ばれる
   * ＝単一候補の自動反映（Codex P2-D）などイベント由来の継続に使う。
   */
  lookupByPostalCode: (
    zip: string,
    onSuccess?: (candidates: AddressLookupCandidate[]) => void,
  ) => void;
  /** 住所 → 郵便番号付き候補（debounce）。スケジュール時点で旧リクエストを無効化する。 */
  searchByAddress: (address: string) => void;
  /** 状態初期化＋保留 debounce 取り消し＋in-flight 応答破棄。 */
  reset: () => void;
  /** unmount 用: 保留 debounce 取り消し＋in-flight 応答破棄（dispatch しない）。 */
  dispose: () => void;
}

export function createAddressLookupController(
  ports: AddressLookupControllerPorts,
  searchDebounceMs: number,
): AddressLookupController {
  // 発行 seq。解決時に最新でなければ結果を破棄する（古い検索/取得が
  // 新しい状態を上書きしないため・owner-link-modal と同じ考え方）。
  let seq = 0;

  const run = async (
    fetcher: () => Promise<{ candidates: AddressLookupCandidate[] }>,
    onSuccess?: (candidates: AddressLookupCandidate[]) => void,
  ) => {
    seq += 1;
    const issued = seq;
    ports.onAction({ type: "request" });
    try {
      const res = await fetcher();
      if (!isLatestRequest(issued, seq)) return; // stale → 破棄（onSuccess も呼ばない）
      const received = res.candidates ?? [];
      ports.onAction({ type: "success", candidates: received });
      onSuccess?.(received);
    } catch (err) {
      if (!isLatestRequest(issued, seq)) return; // stale → 破棄
      ports.onAction({ type: "failure", error: classifyAddressLookupError(err) });
    }
  };

  const debouncedSearch = debounce((address: string) => {
    void run(() => ports.fetchByAddress(address));
  }, searchDebounceMs);

  return {
    lookupByPostalCode(
      zip: string,
      onSuccess?: (candidates: AddressLookupCandidate[]) => void,
    ) {
      // Codex P2-B: 保留中の住所検索を取り消し、明示操作（郵便番号）を優先する。
      // 直後の run() の seq++ が in-flight の住所検索応答も無効化する
      // ＝郵便番号の結果が後発の住所検索に上書きされない。
      debouncedSearch.cancel();
      void run(() => ports.fetchByPostalCode(zip), onSuccess);
    },
    searchByAddress(address: string) {
      // Codex P2-1: スケジュール時点で即 invalidate（debounce 発火を待たない）。
      // 300ms 窓内に旧 in-flight 応答が解決しても isLatestRequest で破棄される。
      seq += 1;
      debouncedSearch(address);
    },
    reset() {
      seq += 1;
      debouncedSearch.cancel();
      ports.onAction({ type: "reset" });
    },
    dispose() {
      seq += 1;
      debouncedSearch.cancel();
    },
  };
}

// ---------------------------------------------------------------
// 住所検索 effect の判定（component から分離した純関数）
// ---------------------------------------------------------------

export type AddressSearchEffectDecision = "none" | "reset" | "search";

/**
 * 住所入力に応じた検索 effect の分岐。
 * Codex P2-A: disabled 中は検索しない（read-only/権限 disabled フォームの表示だけで
 * 住所 PII を route へ送らない・provider 課金を消費しない）。
 * reset 側に倒すことで保留 debounce も破棄される（controller.reset 経由）。
 */
export function decideAddressSearchEffect(
  showSearch: boolean,
  disabled: boolean,
  address: string,
): AddressSearchEffectDecision {
  if (!showSearch) return "none";
  if (disabled) return "reset";
  if (address.trim() === "") return "reset";
  return "search";
}

// ---------------------------------------------------------------
// 住所検索 effect の状態機械（Codex P2-E: mount/プログラム反映では検索しない）
// ---------------------------------------------------------------

export interface AddressSearchEffectState {
  /** 前回 effect が見た住所（mount 時は初期 prop）。同値では検索しない。 */
  lastSeenAddress: string;
  /** 候補反映で自分が書いた住所（次の 1 回だけ検索を抑止して consume する）。 */
  programmaticAddress: string | null;
}

export interface AddressSearchEffectOutcome {
  action: AddressSearchEffectDecision;
  nextState: AddressSearchEffectState;
}

/**
 * 住所検索 effect の判定＋ガード状態遷移。
 * decideAddressSearchEffect（showSearch / disabled / 空）に加えて:
 *  - mount 時の既存住所（lastSeen と同値）では検索しない＝レコードを開いた・
 *    親から既存値が渡ってきただけでは住所 PII を provider へ送らない（Codex P2-E）。
 *  - 候補反映で自分が書いた住所（programmaticAddress）でも検索しない。
 * 検索はユーザー編集等で住所が「変わった」時だけ走る。
 */
export function evaluateAddressSearchEffect(
  showSearch: boolean,
  disabled: boolean,
  address: string,
  state: AddressSearchEffectState,
): AddressSearchEffectOutcome {
  const decision = decideAddressSearchEffect(showSearch, disabled, address);
  if (decision === "none") {
    return { action: "none", nextState: state };
  }
  if (decision === "reset") {
    return {
      action: "reset",
      nextState: { lastSeenAddress: address, programmaticAddress: null },
    };
  }
  if (address === state.lastSeenAddress) {
    // mount 時の既存住所・値の変化なし → 検索しない（P2-E）。
    return { action: "none", nextState: state };
  }
  if (state.programmaticAddress === address) {
    // 候補反映で自分が書いた住所 → consume して検索しない。
    return {
      action: "none",
      nextState: { lastSeenAddress: address, programmaticAddress: null },
    };
  }
  return {
    action: "search",
    nextState: { lastSeenAddress: address, programmaticAddress: null },
  };
}

// ---------------------------------------------------------------
// 候補反映の計画（Codex P2-C: 確認前に親フォームを部分更新しない）
// ---------------------------------------------------------------

export interface CandidateApplication {
  /** immediate=住所欄が空で即反映してよい / needs-confirm=既存住所ありで確認が必要 */
  mode: "immediate" | "needs-confirm";
  /** 反映する郵便番号（候補に無ければ null＝郵便番号は変更しない） */
  zip: string | null;
  /** 反映する住所 */
  addressLine: string;
}

/**
 * 候補を親フォームへどう反映するかの計画。zip と住所を必ずペアで運び、
 * needs-confirm の間はどちらも反映しない＝キャンセル時に
 * 「郵便番号だけ変わって住所は旧値」という不整合を残さない（Codex P2-C）。
 */
export function planCandidateApplication(
  candidate: AddressLookupCandidate,
  currentAddress: string,
): CandidateApplication {
  return {
    mode: shouldAutofillAddress(currentAddress) ? "immediate" : "needs-confirm",
    zip: candidate.postalCode ?? null,
    addressLine: candidate.addressLine,
  };
}
