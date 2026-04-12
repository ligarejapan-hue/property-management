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
