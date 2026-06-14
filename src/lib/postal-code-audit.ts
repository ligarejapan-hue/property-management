/**
 * 郵便番号 × 住所 整合チェック（read-only レポート）の純関数・定数。
 *
 * 所有者(Owner)の保存済み郵便番号(zip)と住所(address)が整合しているかを、
 * 郵便番号 → 住所 lookup（日本郵便 API 等）の結果と突き合わせて点検する。
 * このモジュールは I/O / DB / 外部 API に一切依存しない（純粋・決定的）。
 * API 連携・権限・マスキングは route 側が担う。
 *
 * 設計方針:
 *  - PII egress は「郵便番号のみ」に留める。住所は外部へ送らない（route 側で担保）。
 *    本モジュールは保存住所と取得済み候補住所の比較のみを行う。
 *  - 住所表記ゆれを厳密吸収はしない。`normalizeAddress`（空白正規化）で最小整形した上で、
 *    候補住所が保存住所の「先頭一致 / 含有」になっているかで突き合わせる。
 *    （API 候補は「都道府県+市区町村+町域」までで、保存住所はそれ以降の番地まで含むため、
 *     完全一致ではなく prefix/contains で判定する。）
 */

import { isValidPostalCode, normalizePostalCode, normalizeAddress } from "./address-lookup/normalize";

/** 1 owner の判定結果。 */
export type PostalAuditVerdict =
  /** 取得住所が保存住所と整合（先頭一致 / 含有） */
  | "match"
  /** 取得住所と保存住所が不一致 */
  | "mismatch"
  /**
   * 判定不能。以下のいずれか:
   *  - 保存郵便番号が不正（7桁でない）
   *  - 保存住所が空
   *  - API 候補が 0 件
   *  - API 照合がそもそも行えなかった（未設定 / エラー）
   */
  | "indeterminate";

/** 判定不能の細分理由（非 PII の enum。UI バッジ / 集計用）。 */
export type PostalAuditIndeterminateReason =
  | "invalid_postal_code"
  | "address_empty"
  | "no_candidate"
  | "lookup_unavailable";

/** 比較に渡す API 候補住所（address-lookup の AddressLookupCandidate の最小部分）。 */
export interface PostalAuditCandidate {
  addressLine: string;
}

export interface PostalAuditComparison {
  verdict: PostalAuditVerdict;
  /** indeterminate のときのみ非 null。 */
  reason: PostalAuditIndeterminateReason | null;
  /**
   * match / mismatch 判定の根拠になった候補住所（正規化前の addressLine）。
   * 複数候補のうち一致したものを優先採用する。一致が無ければ先頭候補（mismatch 提示用）。
   * 候補 0 件 / 判定不能(前段) のときは null。
   */
  matchedAddressLine: string | null;
}

/**
 * 1 文字列が他方の住所の「先頭一致」または「含有」かを判定する純関数。
 *
 * API 候補（例: 「東京都千代田区丸の内」）は番地より前までしか持たないことが多く、
 * 保存住所（例: 「東京都千代田区丸の内1-1-1」）はそれを prefix に含む。
 * 逆に保存住所が町域までしか無く候補の方が詳しいケースもあるため、双方向で判定する。
 * 文字種変換（全角半角・漢数字等）の吸収はしない（最小限・保守的）。
 */
export function addressesLooselyMatch(savedAddress: string, candidateAddress: string): boolean {
  const a = normalizeAddress(savedAddress).replace(/\s/g, "");
  const b = normalizeAddress(candidateAddress).replace(/\s/g, "");
  if (a === "" || b === "") return false;
  if (a === b) return true;
  // 短い方が長い方の prefix なら整合とみなす（番地有無の差を吸収）。
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.startsWith(shorter)) return true;
  // prefix でなくても、町域までが含まれていれば整合とみなす（保守的に contains も許容）。
  return longer.includes(shorter);
}

/**
 * 保存郵便番号・保存住所と、郵便番号 lookup で得た候補群を突き合わせて判定する純関数。
 *
 * @param savedPostalCode 保存郵便番号（生値。正規化・妥当性判定は内部で行う）
 * @param savedAddress    保存住所（生値。空判定は内部で行う）
 * @param candidates      郵便番号 lookup の候補。null は「照合不能（未設定/エラー）」を表す。
 */
export function comparePostalAddress(
  savedPostalCode: string | null | undefined,
  savedAddress: string | null | undefined,
  candidates: PostalAuditCandidate[] | null,
): PostalAuditComparison {
  // 照合不能（API 未設定 / lookup エラー）。
  if (candidates === null) {
    return { verdict: "indeterminate", reason: "lookup_unavailable", matchedAddressLine: null };
  }
  // 郵便番号が不正（7 桁でない）。
  if (!savedPostalCode || !isValidPostalCode(savedPostalCode)) {
    return { verdict: "indeterminate", reason: "invalid_postal_code", matchedAddressLine: null };
  }
  // 保存住所が空（trim 後 0 文字）。
  if (!savedAddress || normalizeAddress(savedAddress) === "") {
    return { verdict: "indeterminate", reason: "address_empty", matchedAddressLine: null };
  }
  // 候補 0 件（その郵便番号に住所が引けない = 番号自体が疑わしい）。
  if (candidates.length === 0) {
    return { verdict: "indeterminate", reason: "no_candidate", matchedAddressLine: null };
  }

  // いずれかの候補と loose match すれば一致。
  for (const c of candidates) {
    if (addressesLooselyMatch(savedAddress, c.addressLine)) {
      return { verdict: "match", reason: null, matchedAddressLine: c.addressLine };
    }
  }
  // どの候補とも一致しない = 不一致。先頭候補を提示用に返す。
  return { verdict: "mismatch", reason: null, matchedAddressLine: candidates[0].addressLine };
}

/**
 * 対象件数の安全上限。多数 owner 分の API 呼び出しになるため、これを超える場合は
 * silent に切り捨てず route 側で `truncated` を立てて明示する。
 */
export const POSTAL_AUDIT_MAX_TARGETS = 2000;

/** route が返す 1 owner 分の行（PII は route 側で maskValue 済みの値が入る）。 */
export interface PostalAuditRow {
  ownerId: string;
  /** マスク適用済み所有者名（表示権限に応じて null になり得る）。 */
  nameMasked: string | null;
  /** マスク適用済み保存郵便番号。 */
  zipMasked: string | null;
  /** マスク適用済み保存住所。 */
  addressMasked: string | null;
  /**
   * API が返した住所（候補住所）。保存住所との突き合わせ結果の根拠。
   * これは外部 API 由来の一般地名（番地を含まない都道府県+市区町村+町域）であり
   * 個人を特定しないため、住所表示レベルに関わらず提示する（API 結果そのもの）。
   * ただし保守的に、保存住所がマスクで隠れているレベルでは null にする（route 側制御）。
   */
  apiAddressLine: string | null;
  verdict: PostalAuditVerdict;
  reason: PostalAuditIndeterminateReason | null;
}

/** CSV ヘッダ（DM export と同じく Excel 互換・固定順）。 */
export const POSTAL_AUDIT_CSV_HEADERS = [
  "所有者ID",
  "所有者名",
  "保存郵便番号",
  "保存住所",
  "API住所",
  "判定",
  "理由",
] as const;

export const VERDICT_LABELS: Record<PostalAuditVerdict, string> = {
  match: "一致",
  mismatch: "不一致",
  indeterminate: "判定不能",
};

export const INDETERMINATE_REASON_LABELS: Record<PostalAuditIndeterminateReason, string> = {
  invalid_postal_code: "郵便番号が不正",
  address_empty: "住所が空",
  no_candidate: "該当住所なし",
  lookup_unavailable: "API照合不可",
};

/** PostalAuditRow を CSV 1 行（ヘッダ key → 値）に変換する純関数。 */
export function buildPostalAuditCsvRow(row: PostalAuditRow): Record<string, string> {
  return {
    所有者ID: row.ownerId,
    所有者名: row.nameMasked ?? "",
    保存郵便番号: row.zipMasked ?? "",
    保存住所: row.addressMasked ?? "",
    API住所: row.apiAddressLine ?? "",
    判定: VERDICT_LABELS[row.verdict],
    理由: row.reason ? INDETERMINATE_REASON_LABELS[row.reason] : "",
  };
}

export { normalizePostalCode };
