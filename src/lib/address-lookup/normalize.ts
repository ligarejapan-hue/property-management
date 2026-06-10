/**
 * 郵便番号・住所の正規化ユーティリティ（純関数・I/O なし）。
 *
 * 住所補完 backend で、入力検証と表示整形に使う。外部 API 連携や DB には依存しない。
 */

// 全角数字 ０(U+FF10) と 半角 0(U+0030) のコードポイント差。
const FULLWIDTH_DIGIT_OFFSET = 0xfee0;

/** 全角数字（０-９）を半角数字（0-9）へ変換する。 */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET),
  );
}

/**
 * 郵便番号を正規化する。
 *  - 全角数字 → 半角数字
 *  - 空白（半角/全角）を除去
 *  - ハイフン/ダッシュ類（-, U+2010〜U+2015, 長音 ー, 全角 －）を除去
 *
 * 上記以外の文字は残す（厳密な妥当性判定は {@link isValidPostalCode} で行う）。
 */
export function normalizePostalCode(input: string): string {
  if (!input) return "";
  return toHalfWidthDigits(input)
    .replace(/[\s　]/g, "")
    .replace(/[-‐-―ー－]/g, "");
}

/** 正規化後にちょうど 7 桁の半角数字かどうか。 */
export function isValidPostalCode(input: string): boolean {
  return /^\d{7}$/.test(normalizePostalCode(input));
}

/**
 * 表示用に `123-4567` 形式へ整形する。
 * 正規化後が 7 桁でない場合は正規化後の文字列をそのまま返す（throw しない）。
 */
export function formatPostalCode(input: string): string {
  const n = normalizePostalCode(input);
  return /^\d{7}$/.test(n) ? `${n.slice(0, 3)}-${n.slice(3)}` : n;
}

/**
 * 住所の最小正規化。
 *  - 連続する空白（全角含む）を半角スペース 1 つへ
 *  - 前後の空白を除去
 * 文字種変換や住所表記ゆれの吸収までは行わない（最小限に留める）。
 */
export function normalizeAddress(input: string): string {
  if (!input) return "";
  return input.replace(/[\s　]+/g, " ").trim();
}
