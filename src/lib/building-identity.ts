/**
 * 棟の「比べる形」と「町丁目」(設計 2026-10-04 §3)。
 *
 * ⚠**比べるときだけ使う**(D6)。棟の名前・物件名をこの形で書き換えてはいけない。
 *   正式名称が漢数字やローマ数字の建物があるため。
 * DB にも React にも依存しない純関数だけを置く。
 */
import { normalizeBuildingName } from "@/lib/normalize";

const ROMAN_UPPER_START = 0x2160; // Ⅰ
const ROMAN_LOWER_START = 0x2170; // ⅰ

/** ローマ数字の記号(Ⅰ〜Ⅻ/ⅰ〜ⅻ)を数字にする。⚠NFKC より前に呼ぶ(NFKC は Ⅱ→ii にする)。 */
function romanSymbolsToDigits(s: string): string {
  return s.replace(/[Ⅰ-Ⅻⅰ-ⅻ]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= ROMAN_LOWER_START ? ROMAN_LOWER_START : ROMAN_UPPER_START;
    return String(code - base + 1);
  });
}

const KANJI_DIGITS: Record<string, number> = {
  "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};
const KANJI_RUN = "[〇一二三四五六七八九十百]+";
const COUNTER_SUFFIX = "(番館|号館|号棟|番街|期)";

/** 漢数字の並びを位取りで読む(十=10・二十一=21・百=100)。読めなければ null。 */
export function parseKanjiNumber(run: string): number | null {
  let total = 0;
  let cur = 0;
  let any = false;
  for (const ch of run) {
    if (ch === "百") {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (ch === "十") {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch in KANJI_DIGITS) {
      cur = cur * 10 + KANJI_DIGITS[ch];
    } else {
      return null;
    }
    any = true;
  }
  return any ? total + cur : null;
}

/** 漢数字を**数として使われる位置だけ**数字にする(第〜・〜番館/号館/号棟/番街/期)。 */
function kanjiNumeralsInNumberPositions(s: string): string {
  return s
    .replace(new RegExp(`第(${KANJI_RUN})`, "g"), (_m, run: string) => `第${parseKanjiNumber(run) ?? run}`)
    .replace(
      new RegExp(`(${KANJI_RUN})${COUNTER_SUFFIX}`, "g"),
      (_m, run: string, suffix: string) => `${parseKanjiNumber(run) ?? run}${suffix}`,
    );
}

/** 表記の揺れ: ヶ/ケ/が→ケ、ノ/の/之→ノ、長音とハイフン類→- */
function unifyVariants(s: string): string {
  return s
    .replace(/[ヶヵケが]/g, "ケ")
    .replace(/[ノの之]/g, "ノ")
    .replace(/[ー－‐‑‒–—―−-]/g, "-");
}

/** 棟の名前の比べる形。空・空白だけなら null。 */
export function buildingNameKey(name: string | null | undefined): string | null {
  if (name == null) return null;
  const base = normalizeBuildingName(romanSymbolsToDigits(String(name)));
  if (base === "") return null;
  return unifyVariants(kanjiNumeralsInNumberPositions(base));
}

const CHOME = new RegExp(`^(.*?)(\\d+|[〇一二三四五六七八九十]+)丁目`);

/**
 * 住所から町丁目を取り出す(D2)。丁目が無ければ最初の算用数字(番地)の手前まで。
 * 市区町村(市・区・町・村・郡)を含まないものは短すぎるので null。
 */
export function areaKey(address: string | null | undefined): string | null {
  if (address == null) return null;
  const s = String(address).normalize("NFKC").replace(/[\s　]+/g, "");
  if (s === "") return null;
  let key: string;
  const m = s.match(CHOME);
  if (m) {
    const n = /^\d+$/.test(m[2]) ? Number(m[2]) : parseKanjiNumber(m[2]);
    if (n == null) return null;
    key = `${m[1]}${n}丁目`;
  } else {
    const d = s.search(/\d/);
    key = d === -1 ? s : s.slice(0, d);
  }
  if (!/[市区町村郡]/.test(key)) return null;
  return key;
}

function normForTail(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[ー‐‑‒–—―−]/g, "-");
}

/**
 * 自動で作る棟の住所(§4.3)。受付帳由来の区分は住所の末尾が家屋番号なので、
 * そのときだけ家屋番号の最後の「－」以降(部屋の部分)を除く。
 * 一致しない(手入力の住居表示など)ときは住所のまま=番地の一部を欠かさない。
 */
export function buildingAddressFromUnit(
  address: string,
  buildingNumber: string | null | undefined,
): string {
  const addr = address.trim();
  const nBn = normForTail(buildingNumber ?? "");
  const lastHyphen = nBn.lastIndexOf("-");
  if (lastHyphen <= 0 || !normForTail(addr).endsWith(nBn)) return addr;
  const tailLen = nBn.length - lastHyphen; // 例「-45」=3
  let consumed = 0;
  let i = addr.length;
  while (i > 0 && consumed < tailLen) {
    i -= 1;
    consumed += normForTail(addr[i]).length;
  }
  if (consumed !== tailLen) return addr;
  return addr.slice(0, i).trimEnd();
}
