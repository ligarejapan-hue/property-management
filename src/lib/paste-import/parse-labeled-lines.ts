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

/**
 * 送り元ごとの読み方の違い(source-profiles.ts の parseOptionsFor が決める)。
 * ⚠既定はすべて無効＝従来どおり。HOME4U の2書式の読み方は変えない。
 */
export interface ParseOptions {
  /**
   * 区切りの無い行が「見出し：値」の行の**すぐ下**(間に空行なし)に続くとき、
   * 前の値の続きとして空白でつなぐ。
   * 実サンプル(タカウル): `- ご住所：154-0004` の次の行に住所の本体がある。
   * つながないと、現住所が郵便番号だけになり、住所の本体は「読み取れなかった行」へ落ちる。
   */
  joinContinuationLines?: boolean;
  /**
   * 罫線(━)だけの行で挟まれた範囲を、送り元の署名欄として**見出しで割らない**。
   * 実サンプル(タカウル): 運営会社の `住 所：` `T E L：` `Mail：` が並ぶ。割ると
   * `TEL` が所有者の電話の見出しに当たる(先勝ちで外れても、伏せた項目に紛れて人を迷わせる)。
   * ⚠捨てない。「読み取れなかった行」として残す。
   */
  footerBetweenHeavyRules?: boolean;
}

/** 罫線だけの行(─ ━ = などの連なり)。続き行としてつながない。 */
const RULE_LINE = /^[\s　]*[─━═=＝\-－_]{4,}[\s　]*$/;
const HEAVY_RULE_LINE = /^[\s　]*━{4,}[\s　]*$/;
/**
 * 見出しの位置に URL の方式名だけがある(`https://…` の行の `https`)。
 * ⚠`://` のコロンは区切りではない。割ると見出し「https」・値「//…」になる。
 */
const URL_SCHEME_LABEL = /^[A-Za-z][A-Za-z0-9+.\-]*$/;

export function parseLabeledLines(text: string, options: ParseOptions = {}): ParsedLines {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const labeled: LabeledLine[] = [];
  const unlabeled: string[] = [];
  /** 直前の行が「見出し：値」の行(またはその続き)なら、その行。 */
  let continuable: LabeledLine | null = null;
  let inFooter = false;
  // ⚠署名欄に入るのは**閉じる罫線が後にあるときだけ**(提出前レビュー)。
  //   罫線が奇数本だと(Excel のセルが途中で切れている等)、以降が全部「読み取れ
  //   なかった行」に落ち、Excel 取込が末尾に足す `反響番号：`(二重登録の鍵)まで消える。
  const heavyRuleAt = options.footerBetweenHeavyRules
    ? lines.flatMap((l, i) => (HEAVY_RULE_LINE.test(l) ? [i] : []))
    : [];
  const lastHeavyRule = heavyRuleAt.length > 0 ? heavyRuleAt[heavyRuleAt.length - 1] : -1;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNumber = idx + 1;
    if (trimWide(raw) === "") {
      continuable = null; // 空行で続きは切れる
      continue; // 空行は捨てる
    }

    if (options.footerBetweenHeavyRules && HEAVY_RULE_LINE.test(raw)) {
      // 開く罫線は、後ろに閉じる罫線があるときだけ署名欄の始まりとみなす。
      inFooter = inFooter ? false : idx < lastHeavyRule;
      continuable = null;
      unlabeled.push(trimWide(raw));
      continue;
    }
    if (inFooter) {
      unlabeled.push(trimWide(raw));
      continue;
    }

    let sepAt = firstSeparatorIndex(raw);
    if (
      sepAt !== -1 &&
      raw.startsWith("//", sepAt + 1) &&
      URL_SCHEME_LABEL.test(stripOrnament(raw.slice(0, sepAt)))
    ) {
      sepAt = -1;
    }
    if (sepAt === -1) {
      if (options.joinContinuationLines && continuable !== null && !RULE_LINE.test(raw)) {
        const v = trimWide(raw);
        continuable.value = continuable.value === "" ? v : `${continuable.value} ${v}`;
        continue;
      }
      continuable = null;
      unlabeled.push(trimWide(raw));
      continue;
    }

    const label = stripOrnament(raw.slice(0, sepAt));
    // ⚠ 値の側は最初の区切りより後を**そのまま**取る。値の中のコロンで割らない
    //   （実サンプル「私道（地番：552-11）持ち分あり」がこれに当たる）。
    const value = trimWide(raw.slice(sepAt + 1));

    if (label === "") {
      continuable = null;
      unlabeled.push(trimWide(raw));
      continue;
    }
    const line: LabeledLine = { label, value, lineNumber };
    labeled.push(line);
    continuable = line;
  }

  return { labeled, unlabeled };
}
