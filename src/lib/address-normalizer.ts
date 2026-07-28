/**
 * Japanese address / lot number normalizer for candidate matching.
 *
 * Handles:
 * - Full-width → half-width number conversion
 * - Kanji number → Arabic conversion (一丁目 → 1丁目)
 * - Whitespace normalization
 * - Common suffix variations (丁目, 番地, 番, 号)
 * - Hyphen normalization (ー, ─, ‐, －, - → -)
 */

const KANJI_NUMBERS: Record<string, number> = {
  "〇": 0, "零": 0,
  "一": 1, "壱": 1,
  "二": 2, "弐": 2,
  "三": 3, "参": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
  "十": 10,
  "百": 100,
  "千": 1000,
};

/**
 * Convert a simple Kanji number string to Arabic.
 * Handles up to 千 (thousands).
 * "二十三" → 23, "百五" → 105, "千二百三十四" → 1234
 */
function kanjiToArabic(kanji: string): number {
  let result = 0;
  let current = 0;

  for (const ch of kanji) {
    const val = KANJI_NUMBERS[ch];
    if (val === undefined) return NaN;

    if (val >= 10) {
      // Multiplier
      if (current === 0) current = 1;
      result += current * val;
      current = 0;
    } else {
      current = current * 10 + val;
    }
  }
  result += current;
  return result;
}

/**
 * Normalize a Japanese address for comparison.
 */
export function normalizeAddress(address: string): string {
  let normalized = address;

  // Full-width → half-width numbers
  normalized = normalized.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );

  // Normalize hyphens/dashes
  normalized = normalized.replace(/[ー─‐－―−]/g, "-");

  // Remove spaces
  normalized = normalized.replace(/[\s　]+/g, "");

  // Kanji number sequences before 丁目/番/号
  normalized = normalized.replace(
    /([一二三四五六七八九十百千]+)(丁目|番地|番|号|条)/g,
    (_, kanji, suffix) => {
      const num = kanjiToArabic(kanji);
      return isNaN(num) ? kanji + suffix : num + suffix;
    },
  );

  // Standalone kanji numbers (e.g. in lot numbers)
  normalized = normalized.replace(
    /([一二三四五六七八九十百千]+)(?=[のノ\-])/g,
    (_, kanji) => {
      const num = kanjiToArabic(kanji);
      return isNaN(num) ? kanji : String(num);
    },
  );

  // Normalize 番地 → -
  normalized = normalized.replace(/番地/g, "-");
  // 番 → - (when followed by number)
  normalized = normalized.replace(/番(?=\d)/g, "-");
  // 号 at end or before space
  normalized = normalized.replace(/号$/g, "");

  // 丁目 → -
  normalized = normalized.replace(/丁目/g, "-");

  // Clean up multiple hyphens
  normalized = normalized.replace(/-+/g, "-");
  normalized = normalized.replace(/-$/, "");

  return normalized;
}

/**
 * Normalize a real estate number (不動産番号).
 * Removes hyphens, spaces, and converts to half-width.
 */
export function normalizeRealEstateNumber(num: string): string {
  let normalized = num;
  // Full-width → half-width
  normalized = normalized.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  // Remove non-digits
  normalized = normalized.replace(/[^0-9]/g, "");
  return normalized;
}

/**
 * Normalize a lot number (地番).
 * Handles formats like: "1番2", "1-2", "一番二", etc.
 */
export function normalizeLotNumber(lot: string): string {
  let normalized = lot;

  // Full-width → half-width
  normalized = normalized.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );

  // Normalize hyphens
  normalized = normalized.replace(/[ー─‐－―−]/g, "-");

  // Remove spaces
  normalized = normalized.replace(/[\s　]+/g, "");

  // Kanji numbers
  normalized = normalized.replace(
    /([一二三四五六七八九十百千]+)/g,
    (_, kanji) => {
      const num = kanjiToArabic(kanji);
      return isNaN(num) ? kanji : String(num);
    },
  );

  // 番 → -
  normalized = normalized.replace(/番/g, "-");

  // Clean
  normalized = normalized.replace(/-+/g, "-");
  normalized = normalized.replace(/^-|-$/g, "");

  return normalized;
}

/**
 * Calculate similarity score between two normalized strings (0-1).
 * Uses longest common substring ratio.
 */
export function similarityScore(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;

  // Check containment
  if (longer.includes(shorter)) {
    return shorter.length / longer.length;
  }

  // LCS-based similarity
  let maxLen = 0;
  for (let i = 0; i < shorter.length; i++) {
    for (let j = i + 1; j <= shorter.length; j++) {
      const sub = shorter.substring(i, j);
      if (longer.includes(sub) && sub.length > maxLen) {
        maxLen = sub.length;
      }
    }
  }

  return (2 * maxLen) / (a.length + b.length);
}

/**
 * 住所の「番地の手前」を切り出すために、**番地表記に使われている漢数字だけ**を
 * 算用数字に直す。
 *
 * ⚠漢数字を一律に変換してはいけない: 地名に漢数字は普通に含まれる
 * (四日市市・八王子市・十日町市・六本木・一番町…)。一律変換すると
 * 「三重県四日市市…」が「3重県4日市市…」になり、先頭で切れてキーが空になる。
 * 逆に変換を一切しないと、札幌のように**同じ場所が二通りに書かれる**
 * (「北一条西二丁目」と「北1条西2丁目」) 表記が別キーになり、正規化すれば
 * 一致する相手を DB 段階で落とす (@codex #330 R6)。
 *
 * そこで「直後が 条 / 丁目 / 番 / 番地 / 号」= その位置の漢数字は住所の番号だと
 * 確定できるときだけ変換する。これらは**同じ場所が算用数字でも書かれる**
 * counter で、変換しないと「一番町」と「1番町」が別キーになる (@codex #330 R7)。
 *
 * 丁 単独 (「八丁堀」) は対象にしない: これは地名であって番号ではないため。
 * その代わり、キーに「漢数字 + 丁(目でない)」が残った場合は
 * isAreaKeyNotationStable が false を返し、呼び出し側が絞り込みをやめる。
 */
const ADDRESS_NUMBER_COUNTER_RE =
  /([一二三四五六七八九十百千]+)(条|丁目|番地|番|号)/g;

function arabicizeAddressCounters(address: string): string {
  return address.replace(ADDRESS_NUMBER_COUNTER_RE, (whole, kanji, counter) => {
    const num = kanjiToArabic(kanji);
    return Number.isNaN(num) ? whole : `${num}${counter}`;
  });
}

/**
 * 住所から「表記ゆれに影響されないエリアキー」を取り出す。
 *
 * 重複候補の DB 側プレフィルタ用。生の先頭N文字を使うと
 * 「芝公園4-2-8」と「芝公園4丁目2-8」のように **丁目/ハイフンの表記差**が
 * prefix に食い込み、正規化すれば一致するはずの相手を DB 段階で落としてしまう
 * (@codex #330 R1)。番地は最初の数字以降にしか現れないので、
 * **最初の数字の手前まで**を取れば表記差の影響を受けない。
 *
 * 漢数字は arabicizeAddressCounters で「条/丁目 が続くときだけ」算用数字に
 * 直してから境界を探す (上記コメント参照・@codex #330 R2/R6)。
 *
 * 例: "東京都港区芝公園4-2-8"       → "東京都港区芝公園"
 *     "東京都港区芝公園4丁目2-8"     → "東京都港区芝公園"
 *     "東京都港区芝公園四丁目2-8"     → "東京都港区芝公園"
 *     "三重県四日市市諏訪町1-1"       → "三重県四日市市諏訪町" (地名の漢数字は残す)
 *     "東京都千代田区一番町6-4"       → "東京都千代田区" ("1番町" と同じキー)
 *     "札幌市中央区北一条西二丁目1-1" → "札幌市中央区北"
 *     "札幌市中央区北1条西2丁目1-1"   → "札幌市中央区北" (同じキーになる)
 *
 * ⚠都道府県の省略 (「港区芝公園…」) や市町村合併による表記変更までは吸収
 * できない。DB 絞り込みは「安全に母集団を狭める」ためのもので、最終判定は
 * 呼び出し側の正規化比較が行う。
 */
/**
 * エリアキーが**表記に依存しない**かを判定する。
 *
 * ⚠住所の数字表記の揺れは、字句だけでは地名の一部か番地かを判別できない
 * (四日市市・八王子市 は地名 / 一番町 は「1番町」とも書かれる)。
 * どんな境界規則を選んでも、片方の表記だけキーが短くなる**非対称**が残り、
 * 「どちらの表記で登録されているか」で重複が見つかる/見つからないが変わる
 * (@codex #330 R2/R6/R7 で3巡)。
 *
 * → 表記の推測に**正しさを預けない**。算用数字でも書かれる counter
 * (条/丁目/番/番地/号) は arabicizeAddressCounters が変換するので表記に依存
 * しない。残るのは**変換対象にしなかった counter**、すなわち「漢数字 + 丁
 * (目が続かない)」= 八丁堀 型だけ。この場合だけ「このキーは表記に依存する」と
 * 判定し、呼び出し側は住所での絞り込みを**やめて全件を読み切る**
 * (絞り込みは速さのための最適化にすぎず、最終判定は JS の正規化比較が行う)。
 *
 * ⚠「漢数字を含むか」で判定してはいけない: 地名の漢数字はごく普通で
 * (千代田区・千葉県・三鷹市・四日市市・八王子市・六本木…)、それだけで
 * 絞り込みを捨てると母集団が常に全件になり、絞り込みの意味が無くなる。
 * これらは算用数字で書かれることが無い (「1代田区」とは書かない) ので、
 * 表記の揺れは起きない。
 */
export function isAreaKeyNotationStable(areaKey: string): boolean {
  return !/[一二三四五六七八九十百千]丁(?!目)/.test(areaKey);
}

export function addressAreaKey(address: string): string {
  const arabicized = arabicizeAddressCounters(address);
  // 番地は最初の算用数字 (半角/全角) 以降にしか現れない。
  const boundary = arabicized.search(/[0-9０-９]/);
  const stem = boundary >= 0 ? arabicized.slice(0, boundary) : arabicized;
  return stem.replace(/[\s　]+/g, "").trim();
}
