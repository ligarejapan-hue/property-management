import type { TableElement } from "./document-schema";
import { sanitizeCssValue } from "./css-safety";

export interface TableCellStyle {
  border: string | null;
  padding: string;
  background: string | null;
}

/**
 * 表セル1つ分の見た目。render-html.ts と SalesSheetRenderer.tsx の両方がこれを使い、
 * PDF と編集画面の見た目がずれないようにする。未指定時は従来の出力と同一。
 */
export function tableCellStyle(style: TableElement["style"], rowIndex: number): TableCellStyle {
  const border = style.borderless
    ? null
    : `0.2mm solid ${sanitizeCssValue(style.borderColor ?? "#cccccc")}`;
  const padding =
    style.cellPaddingMm !== undefined
      ? `${style.cellPaddingMm}mm ${Math.round(style.cellPaddingMm * 1.2 * 1000) / 1000}mm`
      : "0.5mm 1mm";
  const background =
    style.stripeColor && rowIndex % 2 === 1 ? sanitizeCssValue(style.stripeColor) : null;
  return { border, padding, background };
}
