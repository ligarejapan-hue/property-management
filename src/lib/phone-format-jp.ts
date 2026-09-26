/**
 * 日本の電話番号をハイフンありの表記にそろえる(純関数)。
 *
 * 発注者決定(2026-09-26): 電話番号はハイフンありで統一し、ハイフンなしで入れたら自動で入れる。
 * 携帯(090-1234-5678)と固定(03-1234-5678 / 045-123-4567 / 0466-12-3456 / 01267-1-2345)で
 * 区切る位置が違い、固定の市外局番(2〜5桁)は番号の並びだけでは決まらない。そのため市外局番の
 * 表を持つ既製部品(libphonenumber-js・発注者承認済み)で判定する。
 *
 * ⚠迷ったら触らない: 番号として正しくない・桁が合わない・内線などの文字が付いたものは
 *   入力どおりに返す(formatted=false)。勝手に書き換えて別の番号に見せる方が害が大きい。
 * ⚠owner-contact-format.ts の normalizePhone(区切り記号の統一だけ・位置は変えない)とは別物。
 */
// "min" の番号データで足りる(日本の区切り位置は入っている・正しくない番号は下の数字一致の検査でも弾く)。
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export interface PhoneFormatResult {
  /** そろえた表記(そろえられないときは入力の前後空白を除いたもの)。 */
  value: string;
  /** 入力から表記を変えたか。 */
  formatted: boolean;
}

// 数字・区切り記号(各種ハイフン・空白・括弧)だけでできているか(NFKC 後)。
const PHONE_CHARS_ONLY = /^[0-9\s\-‐‑‒–—―ー−()]+$/;

export function formatPhoneJp(input: string): PhoneFormatResult {
  const raw = input.trim();
  if (raw === "") return { value: "", formatted: false };
  const nfkc = raw.normalize("NFKC");
  if (!PHONE_CHARS_ONLY.test(nfkc)) return { value: raw, formatted: false };
  const digits = nfkc.replace(/[^0-9]/g, "");
  if (!digits.startsWith("0") || (digits.length !== 10 && digits.length !== 11)) {
    return { value: raw, formatted: false };
  }
  const parsed = parsePhoneNumberFromString(digits, "JP");
  if (!parsed || !parsed.isValid()) return { value: raw, formatted: false };
  const out = parsed.formatNational();
  // 念のため: 数字の並びが変わる整形は採らない(別の番号にしない)。
  if (out.replace(/[^0-9]/g, "") !== digits) return { value: raw, formatted: false };
  return { value: out, formatted: out !== raw };
}

/**
 * 電話番号の検索語を「ハイフンあり/なし」の両方の書き方に広げる(重複は除く・入力どおりの語が先頭)。
 * 保存値はハイフンありに統一していくが、既存データにはハイフンなしも残るため両方で探す。
 * 数字と区切り記号だけの語にだけ効かせる(氏名などの語はそのまま1つ)。
 */
export function phoneSearchVariants(q: string): string[] {
  const out = [q];
  const nfkc = q.normalize("NFKC").trim();
  if (nfkc !== "" && PHONE_CHARS_ONLY.test(nfkc)) {
    const digits = nfkc.replace(/[^0-9]/g, "");
    if (digits !== "") out.push(digits);
    const f = formatPhoneJp(nfkc);
    if (f.value !== nfkc || f.formatted) out.push(f.value);
  }
  return [...new Set(out)];
}

/** 日本の電話番号として正しいか(ハイフンの有無・全角は問わない)。入力欄の「番号を確認してください」用。 */
export function isValidPhoneJp(input: string): boolean {
  const nfkc = input.trim().normalize("NFKC");
  if (nfkc === "" || !PHONE_CHARS_ONLY.test(nfkc)) return false;
  // 数字だけにして整形できれば正しい番号(正しい番号の数字だけの形は、必ずハイフン入りに整形される)。
  return formatPhoneJp(nfkc.replace(/[^0-9]/g, "")).formatted;
}
