/**
 * CSV / XLSX を「1行目=ヘッダ」の行オブジェクト配列に統一変換するヘルパ。
 *
 * - 出力形状は `parseCsv` と同じ `{ headers, rows, errors }`
 *   （`rows` は `Record<string, string>[]`、空文字は「空セル」とする）
 * - XLSX は先頭シートのみ読む
 * - 数値セル（地番・家屋番号・不動産番号など）は指数表記にならないよう明示的に文字列化
 * - 実装差分はこのファイルに閉じ込め、既存の normalize / dedupe / match 層には影響を与えない
 */

import * as XLSX from "xlsx";
import { parseCsv, type CsvParseResult } from "./csv-parser";

export type ImportFileFormat = "csv" | "xlsx" | "unknown";

export class SheetParseError extends Error {
  code:
    | "UNSUPPORTED_FORMAT"
    | "EMPTY_SHEET"
    | "NO_HEADER"
    | "INVALID_INPUT";
  constructor(
    code: SheetParseError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

/** 拡張子からフォーマットを判定する（大文字小文字無視）。 */
export function detectFileFormat(
  fileName: string | null | undefined,
): ImportFileFormat {
  const n = (fileName ?? "").toLowerCase().trim();
  if (!n) return "unknown";
  if (n.endsWith(".csv") || n.endsWith(".tsv") || n.endsWith(".txt")) return "csv";
  if (n.endsWith(".xlsx")) return "xlsx";
  return "unknown";
}

export interface SheetParseInput {
  fileName: string;
  /** CSV 本体（csv 形式時に必須） */
  csvText?: string;
  /** XLSX バイナリの base64（xlsx 形式時に必須） */
  xlsxBase64?: string;
}

export interface SheetParseResult extends CsvParseResult {
  format: "csv" | "xlsx";
}

/**
 * CSV/XLSX を共通形状にパースする。
 * 形式判別失敗・空・入力不足は SheetParseError を投げる。
 */
export function parseSheet(input: SheetParseInput): SheetParseResult {
  const fmt = detectFileFormat(input.fileName);
  if (fmt === "csv") {
    if (typeof input.csvText !== "string" || input.csvText.length === 0) {
      throw new SheetParseError(
        "INVALID_INPUT",
        "CSV本文が空です",
      );
    }
    const r = parseCsv(input.csvText);
    if (r.headers.length === 0) {
      throw new SheetParseError("NO_HEADER", "ヘッダ行を読み取れませんでした");
    }
    return { format: "csv", ...r };
  }
  if (fmt === "xlsx") {
    if (typeof input.xlsxBase64 !== "string" || input.xlsxBase64.length === 0) {
      throw new SheetParseError(
        "INVALID_INPUT",
        "Excelバイナリが空です",
      );
    }
    return parseXlsxFromBase64(input.xlsxBase64);
  }
  throw new SheetParseError(
    "UNSUPPORTED_FORMAT",
    "対応形式は .csv / .xlsx のみです",
  );
}

function parseXlsxFromBase64(base64: string): SheetParseResult {
  let wb: XLSX.WorkBook;
  try {
    const buf = Buffer.from(base64, "base64");
    wb = XLSX.read(buf, { type: "buffer" });
  } catch {
    throw new SheetParseError("INVALID_INPUT", "Excelファイルを解析できませんでした");
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new SheetParseError("EMPTY_SHEET", "Excelにシートがありません");
  }
  const sheet = wb.Sheets[sheetName];
  // raw:true → JS の生値（number / string / Date / boolean）を自前で安全に文字列化する。
  // formatted 文字列（.w）は「1.23E+12」等の指数表記を含むケースがあるため raw を優先する。
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: true,
  });
  if (!aoa || aoa.length === 0) {
    throw new SheetParseError("EMPTY_SHEET", "Excelシートが空です");
  }
  const headerRow = aoa[0] ?? [];
  const headers = headerRow.map((v) => cellToString(v).trim());
  if (headers.every((h) => h === "")) {
    throw new SheetParseError("NO_HEADER", "Excelの1行目が空です");
  }
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i] ?? [];
    // 全セルが空白の行はスキップ
    const values = headers.map((_, j) => cellToString(row[j]).trim());
    if (values.every((v) => v === "")) continue;
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j];
    }
    rows.push(record);
  }
  return { format: "xlsx", headers, rows, errors: [] };
}

/**
 * 任意型のセル値を CSV 互換の文字列に変換する。
 *
 * - number: 整数は `String(n)` で指数表記なし、小数はそのまま
 * - Date: ISO 日付（YYYY-MM-DD）。時刻成分があれば ISO 文字列
 * - boolean: "TRUE" / "FALSE"
 * - null / undefined: 空文字
 */
export function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (Number.isInteger(value)) return String(value);
    // 指数表記になりやすい極小値のみ固定桁へ
    const s = String(value);
    if (/e/i.test(s)) return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    const hasTime =
      value.getUTCHours() !== 0 ||
      value.getUTCMinutes() !== 0 ||
      value.getUTCSeconds() !== 0;
    if (hasTime) return value.toISOString();
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}
