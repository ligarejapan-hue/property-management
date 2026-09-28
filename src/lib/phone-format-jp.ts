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
  // ⚠発注者決定(2026-09-28): 自動で区切るのは**数字だけで入れたとき**だけ。自分で区切った
  //   番号は区切り位置を変えない(部品の割り当て表が実際と違うときに、人が直せる逃げ道。
  //   例: 部品は 0422-12-3456 を 042-212-3456 に区切る)。区切りの文字(全角ハイフン・
  //   長音・空白・括弧)だけを「-」にそろえ、続いた区切りは1つに・先頭末尾は落とす。
  // ⚠端にだけ付いた区切り(「09012345678-」「(0312345678)」)は区切りを入れたことにならない。
  //   先に落としてから判定しないと、自分で区切った扱いになってハイフンが1つも入らない。
  const core = nfkc.replace(/^[^0-9]+|[^0-9]+$/g, "");
  if (!/^[0-9]+$/.test(core)) {
    const unified = core.replace(/[^0-9]+/g, "-");
    return { value: unified, formatted: unified !== raw };
  }
  const digits = core;
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

/** 電話番号の「数字だけで比べる」検索を行う最小の桁数(短いと重い照会になるため・properties/suggest と同じ)。 */
export const MIN_PHONE_SEARCH_DIGITS = 7;

/**
 * 電話番号の検索語を数字だけにする(数字と区切り記号だけの語で、数字が7桁以上のときだけ・それ以外は null)。
 * 保存値はハイフンありへ統一していくが、既存にはハイフンなしも残り、打っている途中の番号は
 * ハイフンの境目をまたぐ。保存値側も数字だけにして比べれば、どの書き方でも当たる(@codex #447 R1)。
 */
export function phoneSearchDigits(q: string): string | null {
  const nfkc = q.normalize("NFKC").trim();
  if (nfkc === "" || !PHONE_CHARS_ONLY.test(nfkc)) return null;
  const digits = nfkc.replace(/[^0-9]/g, "");
  return digits.length >= MIN_PHONE_SEARCH_DIGITS ? digits : null;
}

/** 日本の電話番号として正しいか(ハイフンの有無・全角は問わない)。入力欄の「番号を確認してください」用。 */
export function isValidPhoneJp(input: string): boolean {
  const nfkc = input.trim().normalize("NFKC");
  if (nfkc === "" || !PHONE_CHARS_ONLY.test(nfkc)) return false;
  // 数字だけにして整形できれば正しい番号(正しい番号の数字だけの形は、必ずハイフン入りに整形される)。
  return formatPhoneJp(nfkc.replace(/[^0-9]/g, "")).formatted;
}

/**
 * 保存する電話番号(取り込み経路で使う)。空・空白だけは null、それ以外は画面と同じ規則
 * (formatPhoneJp)でそろえる。以前は画面で入れたときだけハイフンが入り、所有者CSV取込・
 * 取込のやり直し・貼り付けて物件化はハイフンなしのまま保存していた。
 */
export function phoneForStore(input: string | null | undefined): string | null {
  const v = formatPhoneJp(input ?? "").value;
  return v === "" ? null : v;
}

/**
 * 2つの電話番号が同じ番号か(重複の判定に使う)。
 * 手で区切った番号を残すため、保存済みの書き方は決まった形にならない(0422-12-3456 も
 * 042-212-3456 もありうる)。**両方を数字だけにして**比べる(@codex P1 #455)。
 * ⚠数字と区切り以外の文字(内線など)を含む番号は数字だけにしない=書き方が完全に同じ
 *   (前後の空白を除く)ときだけ同じとみなす(「内線12」の数字まで混ぜて別の番号と
 *   取り違えないため)。空は比べない(false)。
 */
export function samePhoneNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = phoneCompareKey(a);
  const kb = phoneCompareKey(b);
  return ka !== null && ka === kb;
}

function phoneCompareKey(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (raw === "") return null;
  const nfkc = raw.normalize("NFKC");
  if (!PHONE_CHARS_ONLY.test(nfkc)) return `raw:${raw}`;
  const digits = nfkc.replace(/[^0-9]/g, "");
  return digits === "" ? null : `digits:${digits}`;
}
