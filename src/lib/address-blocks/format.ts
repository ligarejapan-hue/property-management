/**
 * 街区データ(国土交通省 位置参照情報)から住所文字列を組み立てる純関数群。
 *
 * 方針:
 * - 住居表示(isResidential=true)で町丁目が「…N丁目」なら「西荻北3-1」のハイフン形
 *   (利用者は末尾に号「-8」を足すだけ)。丁目が無い町名は「{町名}{番}番」の正式形。
 * - 地番(isResidential=false・住居表示未実施地域)は「{町名}{地番}番地」形。
 * - 変換できない/想定外の形は**元の表記のまま**正式形で出す(壊れた住所を作らない)。
 */

const KANJI_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 漢数字(一〜九十九・十位まで)を整数へ。丁目は全国でも高々数十なのでこの範囲で足りる。
 * 想定外(百以上・空・混在)は null。
 */
export function kanjiNumberToInt(s: string): number | null {
  const m = /^([一二三四五六七八九]?)(十?)([一二三四五六七八九]?)$/.exec(s);
  if (!m || s === "") return null;
  const [, tensDigit, ten, onesDigit] = m;
  if (!ten) {
    // 「三」のような一桁のみ。「三五」のような並記は不正。
    if (!tensDigit || onesDigit) return null;
    return KANJI_DIGITS[tensDigit];
  }
  const tens = tensDigit ? KANJI_DIGITS[tensDigit] : 1; // 「十」=10
  const ones = onesDigit ? KANJI_DIGITS[onesDigit] : 0;
  return tens * 10 + ones;
}

/** 「西荻北三丁目」→ { base: "西荻北", chome: 3 }。末尾が「N丁目」でなければ null。 */
export function parseTrailingChome(
  town: string,
): { base: string; chome: number } | null {
  const m = /^(.+?)([一二三四五六七八九十]+)丁目$/.exec(town);
  if (!m) return null;
  const chome = kanjiNumberToInt(m[2]);
  if (chome === null) return null;
  return { base: m[1], chome };
}

export interface BlockAddressInput {
  prefecture: string;
  city: string;
  town: string;
  block: string;
  isResidential: boolean;
}

/**
 * 番までの住所文字列を組み立てる。
 * - 住居表示+丁目あり: 東京都杉並区西荻北3-1 (号は利用者が「-8」を追記)
 * - 住居表示+丁目なし: 東京都千代田区一番町1番
 * - 地番地域:          ○○県○○市大字○○1234番地
 */
export function formatBlockAddress(input: BlockAddressInput): string {
  const { prefecture, city, town, block, isResidential } = input;
  if (!isResidential) {
    return `${prefecture}${city}${town}${block}番地`;
  }
  const parsed = parseTrailingChome(town);
  if (parsed && parsed.base !== "") {
    return `${prefecture}${city}${parsed.base}${parsed.chome}-${block}`;
  }
  return `${prefecture}${city}${town}${block}番`;
}
