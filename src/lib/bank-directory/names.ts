/**
 * 金融機関・支店の名前の決まり(2026-11-17 発注者「銀行名の一文字目で検索・支店はその銀行の中から」)。
 * 元データは全銀の略称(「みずほ」「さわやか信金」「神田」)なので、書類にそのまま載る入力欄には
 * 正式な形(「みずほ銀行」「さわやか信用金庫」「神田支店」)に直して入れる。
 * ⚠純関数だけ(取り込みのスクリプトと検索の両方から使う)。
 */

/** 小さいかなを大きいかなへ(全銀の読みは小さい字を大きい字で持つ=「ゆうちよ」)。 */
const SMALL_TO_LARGE: Record<string, string> = {
  ぁ: "あ", ぃ: "い", ぅ: "う", ぇ: "え", ぉ: "お", っ: "つ", ゃ: "や", ゅ: "ゆ", ょ: "よ", ゎ: "わ", ゕ: "か", ゖ: "け",
};
/** 長音・ハイフン・マイナスの類(NFKC のあとに残るもの)。 */
const DASHES = /[ー－‐‑‒–—―−ｰ-]/g;
const KATAKANA_START = 0x30a1; // ァ
const KATAKANA_END = 0x30f6; // ヶ
const KANA_OFFSET = 0x60; // カタカナ → ひらがな

/**
 * 検索のための形: NFKC(全角英数・半角カナをそろえる)→ 小文字 → カタカナをひらがなに →
 * 小さい字を大きい字に → 長音・ハイフン類を「-」に → 空白を消す。
 */
export function toSearchKey(s: string): string {
  const n = s.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of n) {
    const c = ch.codePointAt(0)!;
    const hira = c >= KATAKANA_START && c <= KATAKANA_END ? String.fromCodePoint(c - KANA_OFFSET) : ch;
    out += SMALL_TO_LARGE[hira] ?? hira;
  }
  return out.replace(DASHES, "-").replace(/\s+/g, "");
}

/** 略称の決まりに当たらない金融機関(コードで決める)。 */
const BANK_NAME_EXCEPTIONS: Record<string, string> = {
  "1000": "信金中央金庫",
  "2004": "商工組合中央金庫",
  "2010": "全国信用協同組合連合会",
  "2213": "整理回収機構",
  "2950": "労働金庫連合会",
  "3000": "農林中央金庫",
  "3771": "秋田たかのす農業協同組合",
  "9900": "ゆうちょ銀行",
};
/** 略称の終わり → 正式な終わり(長いものから順に当てる)。 */
const BANK_SUFFIXES: [string, string][] = [
  ["信漁連", "信用漁業協同組合連合会"],
  ["信連", "信用農業協同組合連合会"],
  ["信金", "信用金庫"],
  ["信組", "信用組合"],
  ["労金", "労働金庫"],
  ["農協", "農業協同組合"],
  ["漁協", "漁業協同組合"],
];

/** 金融機関の正式な形。コード 0001〜0999 は銀行(「銀行」を足す)。 */
export function formalBankName(code: string, shortName: string): string {
  const exception = BANK_NAME_EXCEPTIONS[code];
  if (exception) return exception;
  const n = shortName.normalize("NFKC").trim();
  for (const [from, to] of BANK_SUFFIXES) {
    if (n.endsWith(from)) return n.slice(0, -from.length) + to;
  }
  if (Number(code) < 1000 && !n.endsWith("銀行")) return `${n}銀行`;
  return n;
}

/**
 * そのままで支店の名前になっている終わり方(本店・営業部・出張所など)。
 * ⚠「部」「センター」だけでは決めない: 南部・春日部・多摩センター・流通センターなど地名が多い(内部レビュー)。
 *   組織の名前(営業部・本部・公務部・法人部・営業第一部・ローンセンター など)だけそのままにする。
 */
const BRANCH_KEEP = new RegExp(
  "(本店|支店|出張所|代理店|事務所|支所|店"
  + "|営業部|本部|公務部|法人部|ローン部|不動産部|業務部|企画部|サービス部|第[一二三四五六七八九十]+部"
  + "|事務センター|サポートセンター|ビジネスセンター|ローンセンター|営業センター)$",
);
const YUCHO = "9900";

/** 支店の正式な形。「神田」→「神田支店」。ゆうちょ銀行は「〇一八」→「〇一八店」。 */
export function formalBranchName(bankCode: string, shortName: string): string {
  const n = shortName.normalize("NFKC").trim();
  if (BRANCH_KEEP.test(n)) return n;
  return bankCode === YUCHO ? `${n}店` : `${n}支店`;
}
