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
 * 住所から「表記ゆれに影響されないエリアキー」を取り出す。
 *
 * 重複候補の DB 側プレフィルタ用。生の先頭N文字を使うと
 * 「芝公園4-2-8」と「芝公園4丁目2-8」のように **丁目/ハイフンの表記差**が
 * prefix に食い込み、正規化すれば一致するはずの相手を DB 段階で落としてしまう
 * (@codex #330 R1)。番地は最初の数字以降にしか現れないので、
 * **最初の数字の手前まで**を取れば表記差の影響を受けない。
 *
 * 例: "東京都港区芝公園4-2-8"   → "東京都港区芝公園"
 *     "東京都港区芝公園4丁目2-8" → "東京都港区芝公園"
 *     "東京都港区芝公園四丁目"   → "東京都港区芝公園"
 *
 * ⚠漢数字はそれ単体を境界にしてはいけない (@codex #330 R2)。**地名に漢数字は
 * 普通に含まれる**ため (四日市市・八王子市・十日町市・三鷹市・六本木…)、
 * 「最初の漢数字で切る」と "三重県四日市市諏訪町1-1" が空キー、
 * "東京都八王子市横山町1-1" が "東京都" になり、どちらも呼び出し側の最低
 * 文字数を割って**地番の重複検出そのものが丸ごとスキップ**される。
 * 漢数字は「直後に 丁目 が続く」ときだけ番地表記とみなす
 * (八丁堀のような 丁目 でない地名を巻き込まないよう 丁 単独は境界にしない)。
 *
 * ⚠都道府県の省略 (「港区芝公園…」) や市町村合併による表記変更までは吸収
 * できない。DB 絞り込みは「安全に母集団を狭める」ためのもので、最終判定は
 * 呼び出し側の正規化比較が行う。
 */
export function addressAreaKey(address: string): string {
  const boundaries = [
    // 算用数字 (半角/全角)。番地は必ずここ以降。
    address.search(/[0-9０-９]/),
    // 漢数字の丁目表記 ("四丁目")。地名中の漢数字とはここで区別する。
    address.search(/[一二三四五六七八九十]+丁目/),
  ].filter((i) => i >= 0);
  const stem =
    boundaries.length > 0 ? address.slice(0, Math.min(...boundaries)) : address;
  return stem.replace(/[\s　]+/g, "").trim();
}
