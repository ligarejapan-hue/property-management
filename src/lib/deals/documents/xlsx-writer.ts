import type ExcelJS from "exceljs";

/** 書類の Excel を上から1行ずつ書く部品(資金計画表・事業計画書で共通)。文字はすべて文字の値として入れる(数式として読まれない)。 */

export const YEN = "#,##0";
export const PERCENT = "0.00%";
export type XlsxValue = number | null | { formula: string; result: number };

export class Writer {
  row = 1;
  constructor(readonly ws: ExcelJS.Worksheet) {}

  /** 見出し(A列だけ・太字)。 */
  heading(text: string) {
    this.row++;
    const c = this.ws.getCell(`A${this.row}`);
    c.value = text;
    c.font = { bold: true, size: 12 };
    this.row++;
  }

  /** ラベルと値(または数式)の1行。行番号を返す。numFmt の既定は円。 */
  line(label: string, value: XlsxValue, opts: { bold?: boolean; numFmt?: string } = {}): number {
    const r = this.row++;
    this.ws.getCell(`A${r}`).value = label;
    const b = this.ws.getCell(`B${r}`);
    b.value = value;
    b.numFmt = opts.numFmt ?? YEN;
    if (opts.bold) {
      this.ws.getCell(`A${r}`).font = { bold: true };
      b.font = { bold: true };
    }
    return r;
  }

  /** ラベルと文字の1行。 */
  pair(label: string, value: string) {
    const r = this.row++;
    this.ws.getCell(`A${r}`).value = label;
    this.ws.getCell(`B${r}`).value = value;
  }

  text(t: string) {
    this.ws.getCell(`A${this.row++}`).value = t;
  }
}

/** 金額のある行だけを並べ、最初と最後の行番号を返す(1行も無ければ null)。 */
export function amountLines(w: Writer, lines: { label: string; amount: number | null }[]): { first: number; last: number } | null {
  const shown = lines.filter((l) => l.amount !== null);
  if (!shown.length) return null;
  const first = w.row;
  for (const l of shown) w.line(l.label, l.amount);
  return { first, last: w.row - 1 };
}

export const sumOf = (range: { first: number; last: number } | null, result: number): XlsxValue =>
  range ? { formula: `SUM(B${range.first}:B${range.last})`, result } : 0;
