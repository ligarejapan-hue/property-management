/**
 * 謄本PDFの「下線（＝抹消事項）」を、文字ごとの印として行に組み立てる。
 *
 * 登記事項証明書では「下線のあるものは抹消事項であることを示す」（証明書の欄外に印字）。
 * 登記情報提供サービスのPDFでは、下線は文字ではなく**図形の横線**として描かれている。
 * 実物で確かめた形（2026-10 全部事項・区分建物）:
 *   - 1文字ずつ（幅＝文字幅 8.4pt）の水平線。線幅 0.1。
 *   - 線の高さは「文字のベースライン − 1.0pt」でそろっている。
 *   - 表の罫線（┃│━ など）は**文字**として描かれており、図形の線は下線だけ。
 * pdf-parse の文字抽出では図形が落ちるため、下線の情報は失われていた。
 *
 * このファイルは PDF に依存しない純関数だけを置く（テストで座標を直接与えられるように）。
 * PDF からの読み出しは `extract.ts`。
 */

/** 文字の並び（pdfjs の TextItem を単純化したもの）。座標は PDF のユーザー空間（下が 0）。 */
export interface StrikeTextItem {
  str: string;
  /** 左端の x */
  x: number;
  /** ベースラインの y */
  y: number;
  /** 文字列全体の幅 */
  width: number;
  /** 文字の大きさ（変換行列の縦倍率） */
  fontSize: number;
}

/** 水平な線分。 */
export interface StrikeSegment {
  x1: number;
  x2: number;
  y: number;
}

/** 1行分の文字と、文字ごとの「下線あり」印。 */
export interface StrikeLine {
  page: number;
  text: string;
  /** text と同じ長さ（コードポイント単位）。true = 下線あり（抹消事項）。 */
  struck: boolean[];
}

/**
 * 下線とみなす線の高さの範囲（ベースラインからの下がり幅を、文字の大きさに対する割合で）。
 * 実物は 1.0pt / 8.4pt ≒ 0.12。罫線や次の行の文字と取り違えないよう狭めに取る。
 */
const UNDERLINE_MIN_DROP = 0.03;
const UNDERLINE_MAX_DROP = 0.3;
/** 同じ行とみなすベースラインの差（pt）。 */
const SAME_LINE_TOLERANCE = 0.5;

/**
 * 文字と線分から、行ごとの「下線あり」印を作る。
 * 文字の中心の真下（許容範囲内）に水平線があれば、その文字は下線あり。
 */
export function buildStrikeLines(
  page: number,
  items: StrikeTextItem[],
  segments: StrikeSegment[],
): StrikeLine[] {
  type Ch = { x: number; ch: string; struck: boolean };
  const rows: { y: number; chars: Ch[] }[] = [];

  for (const item of items) {
    const chars = Array.from(item.str);
    if (chars.length === 0) continue;
    const cw = item.width / chars.length;
    let row = rows.find((r) => Math.abs(r.y - item.y) <= SAME_LINE_TOLERANCE);
    if (!row) {
      row = { y: item.y, chars: [] };
      rows.push(row);
    }
    const minDrop = item.fontSize * UNDERLINE_MIN_DROP;
    const maxDrop = item.fontSize * UNDERLINE_MAX_DROP;
    chars.forEach((ch, i) => {
      const left = item.x + cw * i;
      const center = left + cw / 2;
      const struck =
        ch.trim() !== "" &&
        segments.some((s) => {
          const drop = item.y - s.y;
          return (
            drop >= minDrop &&
            drop <= maxDrop &&
            center >= Math.min(s.x1, s.x2) &&
            center <= Math.max(s.x1, s.x2)
          );
        });
      row!.chars.push({ x: left, ch, struck });
    });
  }

  // 上の行から順に（PDF の y は下が 0）
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.chars.sort((a, b) => a.x - b.x);
    return {
      page,
      text: r.chars.map((c) => c.ch).join(""),
      struck: r.chars.map((c) => c.struck),
    };
  });
}

/** 貼り付けテキストなど、下線の情報が無いときの行（すべて「下線なし」）。 */
export function linesFromPlainText(text: string): StrikeLine[] {
  return text.split(/\r?\n/).map((t) => ({
    page: 1,
    text: t,
    struck: Array.from(t).map(() => false),
  }));
}

/** 行の一部（[start, end)）を、下線の印つきで切り出す。 */
export function sliceStrike(line: StrikeLine, start: number, end: number): StrikeLine {
  const chars = Array.from(line.text);
  return {
    page: line.page,
    text: chars.slice(start, end).join(""),
    struck: line.struck.slice(start, end),
  };
}

/** 空白以外の文字がすべて下線つきか（空白だけなら false）。 */
export function isFullyStruck(line: Pick<StrikeLine, "text" | "struck">): boolean {
  const chars = Array.from(line.text);
  let seen = false;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].trim() === "") continue;
    seen = true;
    if (!line.struck[i]) return false;
  }
  return seen;
}

/** 空白以外の文字に1つでも下線があるか。 */
export function hasAnyStrike(line: Pick<StrikeLine, "text" | "struck">): boolean {
  const chars = Array.from(line.text);
  return chars.some((c, i) => c.trim() !== "" && line.struck[i]);
}
