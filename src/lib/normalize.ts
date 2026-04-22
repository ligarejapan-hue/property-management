/**
 * 物件表記ゆれの比較用正規化
 *
 * - 目的は CSV 取込時の重複判定精度向上
 * - 元データを書き換えるためではなく「比較用値」を作るための関数群
 * - 漢字異体字や地名辞書は対象外（将来拡張）
 */

// ---------- 共通ユーティリティ ----------

/**
 * 住所・建物名・部屋番号で共通して掛ける基礎正規化。
 *
 * - null/undefined → ""
 * - NFKC 正規化（全角英数→半角、全角記号→半角、濁点結合など）
 * - 前後空白除去
 * - 連続空白の圧縮（半角/全角スペース/タブを単一半角スペースへ）
 * - 英字は lowercase に統一
 */
function baseNormalize(input: string | null | undefined): string {
  if (input == null) return "";
  const s = String(input).normalize("NFKC");
  return s
    .replace(/[\s\u3000]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * ASCII ハイフン類似文字を半角 `-` に統一する。
 *
 * 対象（カタカナ長音「ー」U+30FC は含めない。文字として意味が異なるため）:
 * - U+2010 HYPHEN
 * - U+2011 NON-BREAKING HYPHEN
 * - U+2012 FIGURE DASH
 * - U+2013 EN DASH
 * - U+2014 EM DASH
 * - U+2015 HORIZONTAL BAR
 * - U+2212 MINUS SIGN
 * - U+FF0D FULLWIDTH HYPHEN-MINUS（NFKC で既に `-` になるが念のため）
 * - U+30FB KATAKANA MIDDLE DOT（住所の「1・2・3」表記対策用: オフ、誤変換の温床）
 * - U+FF5E / U+301C WAVE DASH「〜」→ `-`（番地範囲表記）
 */
function unifyHyphens(s: string): string {
  return s.replace(/[\u2010-\u2015\u2212\uFF0D\uFF5E\u301C]/g, "-");
}

// ---------- 公開API ----------

/**
 * 住所の比較用正規化値。
 *
 * 安全側に倒しているため、地名の意味を変える変換（例: 「丁目」→「-」、
 * 「番地」削除、字の補完など）は一切行わない。
 */
export function normalizeAddress(input: string | null | undefined): string {
  return unifyHyphens(baseNormalize(input));
}

/**
 * 建物名の比較用正規化値。
 *
 * - 基礎正規化のみ。カタカナ長音は保持（アパート名の一部として意味があるため）
 * - ハイフン統一は建物名では悪影響が出やすいため適用しない
 */
export function normalizeBuildingName(
  input: string | null | undefined,
): string {
  return baseNormalize(input);
}

/**
 * 部屋番号の比較用正規化値。
 *
 * - 基礎正規化 + ハイフン統一
 * - 内部空白もすべて除去（「101 号室」「101号室」「101号」の差異を吸収）
 * - 末尾の「号室」「号」は保持しないでよいが、今回は意味破壊回避のため残す
 */
export function normalizeRoomNo(input: string | null | undefined): string {
  return unifyHyphens(baseNormalize(input)).replace(/\s+/g, "");
}

/**
 * 物件単位の重複判定キー。CSV 取込側から再利用する想定。
 *
 * 呼び出し側で null/undefined を気にせず渡せるよう、各フィールドは任意。
 */
export interface PropertyDedupeKey {
  address: string;
  buildingName: string;
  roomNo: string;
}

export function buildPropertyDedupeKey(input: {
  address?: string | null;
  buildingName?: string | null;
  roomNo?: string | null;
}): PropertyDedupeKey {
  return {
    address: normalizeAddress(input.address),
    buildingName: normalizeBuildingName(input.buildingName),
    roomNo: normalizeRoomNo(input.roomNo),
  };
}
