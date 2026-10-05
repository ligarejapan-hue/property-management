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

const PREFECTURE = new RegExp(
  "^(北海道|東京都|京都府|大阪府|" +
    "(青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|" +
    "静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|" +
    "熊本|大分|宮崎|鹿児島|沖縄)県)",
);

/**
 * 町丁目の key が本当の市区町村から始まっているか。
 * ⚠「市区町村郡の字がどこかにある」では足りない(「村上1丁目」「上村町」は町名の中の字)。
 * 先頭の都道府県(47)を外し、**残りの中だけ**で市区町村を探す(都道府県なしなら住所全体で同じ規則):
 * - 市・区 = 1文字以上のあとに「市」か「区」(残りの頭の「市」=「東京都市谷…」の市谷は数えない)
 * - 郡 = 1文字以上のあとに「郡」、さらに1文字以上のあとに「町」か「村」
 * 見つからなければ null 側に倒す(=町丁目不明として新しい棟を作る=取り違えより安全)。
 * ⚠郡の無い島の町(「東京都大島町」など)も null になる=取りこぼしを受け入れる(コントローラ判断 2026-10-05)。
 */
function hasMunicipality(key: string): boolean {
  const pref = key.match(PREFECTURE);
  const rest = pref ? key.slice(pref[0].length) : key;
  return /^.+?[市区]/.test(rest) || /^.+?郡.+?[町村]/.test(rest);
}

/**
 * 住所から町丁目を取り出す(D2)。丁目が無ければ最初の算用数字(番地)の手前まで。
 * 本当の市区町村から始まらないもの(hasMunicipality)は短すぎるので null。
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
  if (!hasMunicipality(key)) return null;
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
