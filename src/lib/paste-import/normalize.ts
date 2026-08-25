/**
 * 貼り付け取込で全段が共有する正規化。純関数のみ。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */

/** 全角の英数字・記号を半角へ。**カナや漢字は変換しない**（氏名を壊さないため）。 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[－ー−―]/g, "-");
}

/** 元号の開始年（その元号の1年＝この西暦）。 */
const ERAS: { name: string; startYear: number }[] = [
  { name: "令和", startYear: 2019 },
  { name: "平成", startYear: 1989 },
  { name: "昭和", startYear: 1926 },
  { name: "大正", startYear: 1912 },
  { name: "明治", startYear: 1868 },
];

/**
 * 和暦（平成8年 など）を西暦に。西暦がそのまま書かれていればその数値を返す。
 * 読み取れなければ null（**推測しない**）。
 */
export function warekiToSeireki(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/[\s　]/g, "");
  if (s === "") return null;

  for (const era of ERAS) {
    if (!s.includes(era.name)) continue;
    const m = new RegExp(`${era.name}(元|\\d{1,2})年`).exec(s);
    if (!m) return null;
    const nth = m[1] === "元" ? 1 : Number(m[1]);
    if (!Number.isFinite(nth) || nth < 1) return null;
    return era.startYear + nth - 1;
  }

  // 西暦（4桁）。年号らしき語が無いときだけ採用する。
  const seireki = /(1[89]\d{2}|20\d{2})\s*年?/.exec(s);
  return seireki ? Number(seireki[1]) : null;
}

/** 「70 平米」「70.55㎡」などを数値へ。数値が無ければ null。 */
export function parseAreaSqm(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/,/g, "");
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 住所の括弧書きに入っている地番を分離する。
 * 実サンプル: `世田谷区池尻4丁目26-8（地番552-2）`
 *
 * ⚠ 住居表示と地番は別物で、登記は地番でしか引けない。ここで分けそこねると
 *   後から謄本が取れなくなる。**地番と明記された括弧だけ**を対象にし、
 *   それ以外の括弧書きは住所に残す（勝手に消さない）。
 */
export function splitLotNumberFromAddress(raw: string): {
  address: string;
  lotNumber: string | null;
} {
  const re = /[（(]\s*地番\s*[:：]?\s*([^）)]+?)\s*[）)]/;
  const m = re.exec(raw);
  if (!m) return { address: raw.trim(), lotNumber: null };
  const address = raw.replace(re, "").replace(/[\s　]+$/, "").trim();
  return { address, lotNumber: m[1].trim() };
}
