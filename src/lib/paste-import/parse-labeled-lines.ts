/**
 * 段2: 貼られたテキストを「見出し(label)」と「中身(value)」に割る純関数。
 *
 * 区切りは全角コロン `：` / 半角コロン `:` / タブ を等価に扱う。
 * 実サンプルの実測: HOME4U 査定依頼は全角コロン、空き家相談 PDF はタブ。
 *
 * ⚠ Prisma / next / node:fs を import しないこと（純関数を保つため）。
 */

export interface LabeledLine {
  label: string;
  value: string;
  /** 原文の何行目か（1始まり）。確認画面で原文と突き合わせるために持つ。 */
  lineNumber: number;
}

export interface ParsedLines {
  labeled: LabeledLine[];
  /** 区切りが無かった行。捨てずに持つ（原文照合と、拾い漏れの調査のため）。 */
  unlabeled: string[];
}

/** 行頭の飾り文字。実サンプルに出たものと、同種でよく使われるもの。 */
const ORNAMENT = /^[\s　]*[■●◆▼▶・*※\-–—]?[\s　]*/;
/** 【ラベル】形式の括弧。 */
const BRACKET = /^【(.*)】$/;

const SEPARATORS = ["：", ":", "\t"];

/** 全角・半角の空白を両端から落とす。 */
function trimWide(s: string): string {
  return s.replace(/^[\s　]+/, "").replace(/[\s　]+$/, "");
}

/**
 * 「値なし」を見分ける。実サンプルAでは 9 項目が "-" だった。
 * 0 や "なし" は**意味のある値**なので値なしにしない。
 */
export function isBlankValue(value: string): boolean {
  const t = trimWide(value);
  if (t === "") return true;
  return /^[-ー−―]+$/.test(t);
}

function stripOrnament(label: string): string {
  const withoutOrnament = trimWide(label.replace(ORNAMENT, ""));
  const bracket = BRACKET.exec(withoutOrnament);
  return bracket ? trimWide(bracket[1]) : withoutOrnament;
}

/** 最初に現れる区切りの位置。見つからなければ -1。 */
function firstSeparatorIndex(line: string): number {
  let found = -1;
  for (const sep of SEPARATORS) {
    const i = line.indexOf(sep);
    if (i !== -1 && (found === -1 || i < found)) found = i;
  }
  return found;
}

export function parseLabeledLines(text: string): ParsedLines {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const labeled: LabeledLine[] = [];
  const unlabeled: string[] = [];

  lines.forEach((raw, idx) => {
    const lineNumber = idx + 1;
    if (trimWide(raw) === "") return; // 空行は捨てる

    const sepAt = firstSeparatorIndex(raw);
    if (sepAt === -1) {
      unlabeled.push(trimWide(raw));
      return;
    }

    const label = stripOrnament(raw.slice(0, sepAt));
    // ⚠ 値の側は最初の区切りより後を**そのまま**取る。値の中のコロンで割らない
    //   （実サンプル「私道（地番：552-11）持ち分あり」がこれに当たる）。
    const value = trimWide(raw.slice(sepAt + 1));

    if (label === "") {
      unlabeled.push(trimWide(raw));
      return;
    }
    labeled.push({ label, value, lineNumber });
  });

  return { labeled, unlabeled };
}
