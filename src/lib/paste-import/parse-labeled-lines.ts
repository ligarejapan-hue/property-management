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
   * 値が**郵便番号だけ**の「見出し：値」の行のすぐ下(間に空行なし)の1行を、
   * 住所の本体として空白でつなぐ。
   * 実サンプル(タカウル): `- ご住所：154-0004` の次の行に住所の本体がある。
   * つながないと、現住所が郵便番号だけになり、住所の本体は「読み取れなかった行」へ落ちる。
   * ⚠**郵便番号の後だけ**に絞る(@codex PR#491 3巡目)。どの行でもつなぐと、
   *   `お名前：山田太郎` の次の説明文が氏名にくっつく。
   */
  joinAfterPostalCode?: boolean;
  /**
   * 罫線(━)だけの行で挟まれた範囲(閉じる罫線が無ければ文末まで)を、
   * 送り元の署名欄として**見出しで割らない**。
   * 実サンプル(タカウル): 運営会社の `住 所：` `T E L：` `Mail：` が並ぶ。割ると
   * `TEL` が所有者の電話の見出しに当たる(先勝ちで外れても、伏せた項目に紛れて人を迷わせる)。
   * ⚠捨てない。「読み取れなかった行」として残す。
   */
  footerBetweenHeavyRules?: boolean;
  /**
   * 区切りが抜けて見出しと値がくっついた行を、**この見出しで始まるときだけ**割る。
   * 実サンプル(HOME4U 表の形 2026-10-26): `査定依頼者建物名号室〇〇マンション〇号室`
   * (ほかの行はタブ区切りなのに、この行だけタブが無い)。
   * ⚠見出しを決め打ちにする。区切りの無い行を辞書で割り始めると、説明文の頭が
   *   見出しに当たって値にされる。
   */
  gluedLabels?: readonly string[];
  /**
   * 「［見出し］」だけの行の次の行(空行まで)を、その見出しの値にする。
   * 実サンプル(イエイ 2026-11-06): `［物件所在地］` の次の行に住所。
   * - 氏名の見出し(［姓名］)の下で、値の2行目以降が括弧で囲まれた行(`（ヤマダ ハナコ）`)は
   *   見出し「フリガナ」の値にする。ほかの2行目以降は空白でつなぐ。
   * - 空行・「▼」で始まる節の行・次の「［見出し］」の行で値は終わる。
   * - 「見出し：値」で割るのは［連絡先］の下の行だけ。ほかの行のコロンでは割らない。
   * - `━` で始まる行(`━ ZIGExN Co.,Ltd.━━━`)から後ろは署名欄として見出しで割らない。
   * ⚠捨てない。読まなかった行は「読み取れなかった行」に残す。
   */
  bracketHeadings?: boolean;
  /**
   * 見出しの読み替え(送り元に固有の見出しだけ)。キーは原文の見出し(前後の空白なし)。
   * 例: イエイの「お客様情報」の節の `［住所］` → 「ご住所」(現住所)。
   */
  labelAliases?: Readonly<Record<string, string>>;
}

/** 「［見出し］」だけの行。中にコロンがあるもの(`［受付時間：10:00～19:00］`)は見出しにしない。 */
const BRACKET_HEADING = /^［([^［］：:]+)］$/;
/** 括弧で囲まれた行(フリガナ)。 */
const PAREN_WRAPPED = /^[（(](.+)[）)]$/;
/** 値の2行目の括弧をフリガナとして読む見出し。 */
const NAME_HEADINGS: ReadonlySet<string> = new Set(["姓名", "お名前", "氏名"]);
/** 「見出し：値」の行を並べる見出し(イエイ `［連絡先］` の下の `電話番号1：…`)。 */
const CONTACT_HEADING = "連絡先";

/** 罫線だけの行(─ ━ = などの連なり)。住所の本体としてつながない。 */
const RULE_LINE = /^[\s　]*[─━═=＝\-－_]{4,}[\s　]*$/;
/** 郵便番号だけの値(〒の有無・全角半角・ハイフンの有無を問わない)。 */
const POSTAL_CODE_ONLY = /^〒?[\s　]*[0-9０-９]{3}[\s　]*[-－ー−―‐]?[\s　]*[0-9０-９]{4}$/;
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
  /** 直前の行が「見出し：郵便番号」の行なら、その行(次の1行だけつなぐ)。 */
  let continuable: LabeledLine | null = null;
  let inFooter = false;
  // ⚠閉じる罫線が無くても、開いた後ろは署名欄として読まない(@codex PR#491 4巡目)。
  //   セルが署名欄の途中で切れていると、運営会社の `T E L：` が所有者の電話に入る。
  //   読まなかった行は「読み取れなかった行」に残る(捨てない)。Excel 取込の
  //   鍵(反響番号)は本文の先頭に置くので飲み込まれない(lead-sheet.ts)。
  const aliasOf = (label: string): string => options.labelAliases?.[label] ?? label;
  /** 「［見出し］」の行のあと、値の行を集めている途中(bracketHeadings のときだけ)。 */
  let pending: { label: string; lineNumber: number; lines: string[] } | null = null;
  /** `━` で始まる行から後ろ(bracketHeadings の署名欄)。閉じない。 */
  let inSignature = false;
  /** 最後に出た「［見出し］」(▼の節の行で消える)。 */
  let lastHeading: string | null = null;
  const flushPending = () => {
    if (pending === null) return;
    const { label, lineNumber, lines: valueLines } = pending;
    pending = null;
    if (valueLines.length === 0) return; // 値の無い見出し(`［賃料］` の下が空)は拾わない
    let value = valueLines[0];
    const kana: string[] = [];
    for (const extra of valueLines.slice(1)) {
      // ⚠フリガナにするのは氏名の見出しの下だけ(提出前レビュー)。`［ご要望など］` の
      //   `（午前中に電話希望）` が所有者のフリガナの欄を先に取らないように。
      const m = NAME_HEADINGS.has(label) ? PAREN_WRAPPED.exec(extra) : null;
      if (m) kana.push(trimWide(m[1]));
      else value = `${value} ${extra}`;
    }
    labeled.push({ label: aliasOf(label), value, lineNumber });
    for (const k of kana) labeled.push({ label: "フリガナ", value: k, lineNumber });
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNumber = idx + 1;
    if (trimWide(raw) === "") {
      continuable = null; // 空行で続きは切れる
      if (pending !== null && pending.lines.length > 0) flushPending();
      continue; // 空行は捨てる
    }

    if (options.footerBetweenHeavyRules && HEAVY_RULE_LINE.test(raw)) {
      inFooter = !inFooter;
      continuable = null;
      unlabeled.push(trimWide(raw));
      continue;
    }
    if (options.bracketHeadings && !inSignature && /^[\s　]*━/.test(raw)) {
      flushPending();
      inSignature = true;
    }
    if (inFooter || inSignature) {
      unlabeled.push(trimWide(raw));
      continue;
    }

    if (options.bracketHeadings) {
      const trimmed = trimWide(raw);
      const heading = BRACKET_HEADING.exec(trimmed);
      if (heading) {
        flushPending();
        pending = { label: trimWide(heading[1]), lineNumber, lines: [] };
        lastHeading = pending.label;
        continuable = null;
        continue;
      }
      if (trimmed.startsWith("▼")) {
        // 節の行(▼お客様情報)で値は終わる。
        flushPending();
        lastHeading = null;
        unlabeled.push(trimmed);
        continue;
      }
      // ⚠「見出し：値」で割るのは［連絡先］の下だけ(電話番号1：…)。ほかの値の中のコロン
      //   (`12:00〜15:00`・`（地番：45）`)や冒頭の `（2026-11-06 10:45:10）に…` は割らない
      //   (提出前レビュー)。空行のあとの自由記述の2段落目の `TEL：…` が電話の欄に先に入るのも防ぐ。
      const contactLine = lastHeading === CONTACT_HEADING && firstSeparatorIndex(raw) !== -1;
      if (pending !== null && !contactLine) {
        pending.lines.push(trimmed);
        continue;
      }
      flushPending();
      if (!contactLine) {
        unlabeled.push(trimmed);
        continue;
      }
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
      const trimmed = trimWide(raw);
      const glued = options.gluedLabels?.find((l) => trimmed.startsWith(l) && trimmed.length > l.length);
      if (glued !== undefined) {
        labeled.push({ label: glued, value: trimWide(trimmed.slice(glued.length)), lineNumber });
        continuable = null;
        continue;
      }
      if (continuable !== null && !RULE_LINE.test(raw)) {
        continuable.value = `${continuable.value} ${trimWide(raw)}`;
        continuable = null;
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
    const line: LabeledLine = { label: aliasOf(label), value, lineNumber };
    labeled.push(line);
    continuable = options.joinAfterPostalCode && POSTAL_CODE_ONLY.test(value) ? line : null;
  }
  flushPending();

  return { labeled, unlabeled };
}
