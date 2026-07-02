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
    | "INVALID_INPUT"
    | "INPUT_TOO_LARGE"
    | "UNSAFE_HEADER";
  constructor(
    code: SheetParseError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

/**
 * 取込1ファイルの上限（デコード後バイト）。ReDoS/メモリ枯渇の「増幅」を防ぐ多層防御。
 * 取込は物件/所有者リスト＝実運用では小さい。既定10MB（数万行相当）で十分。
 */
export const MAX_IMPORT_DECODED_BYTES = 10 * 1024 * 1024;

/**
 * プロトタイプ汚染を招くヘッダ名（列名）。正当な取込ファイルには存在しないため取込を拒否する
 * （SheetJS 本体の脆弱性はライブラリ更新で修正済／これは多層防御）。
 */
const DANGEROUS_HEADER_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** ヘッダに危険なキーが含まれていれば取込を拒否する。 */
function assertSafeHeaders(headers: readonly string[]): void {
  for (const h of headers) {
    if (DANGEROUS_HEADER_KEYS.has(h)) {
      throw new SheetParseError(
        "UNSAFE_HEADER",
        "列名に使用できない予約語（__proto__ など）が含まれています",
      );
    }
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
  /**
   * このヘッダ名に一致する列だけ、XLSX セルの整形済みテキスト（.w）を採用する。
   * 郵便番号のように「数値セルで先頭0が落ちる」列を、表示文字列で取り込むための指定。
   * 未指定/空、または対象ヘッダが無い場合は従来通り単一パス（raw 値）で読む。
   * CSV には影響しない（CSV は元々テキスト）。
   */
  formattedTextHeaders?: ReadonlySet<string>;
  /**
   * デコード後の上限バイト。これを超える入力は解析前に INPUT_TOO_LARGE で弾く
   * （ReDoS/メモリ枯渇の増幅防止）。未指定は {@link MAX_IMPORT_DECODED_BYTES}。
   */
  maxDecodedBytes?: number;
}

export interface SheetParseResult extends CsvParseResult {
  format: "csv" | "xlsx";
}

/**
 * CSV/XLSX を共通形状にパースする。
 * 形式判別失敗・空・入力不足は SheetParseError を投げる。
 * サイズ上限超過（INPUT_TOO_LARGE）・危険ヘッダ（UNSAFE_HEADER）も拒否する。
 */
export function parseSheet(input: SheetParseInput): SheetParseResult {
  const maxBytes = input.maxDecodedBytes ?? MAX_IMPORT_DECODED_BYTES;
  const fmt = detectFileFormat(input.fileName);
  if (fmt === "csv") {
    if (typeof input.csvText !== "string" || input.csvText.length === 0) {
      throw new SheetParseError(
        "INVALID_INPUT",
        "CSV本文が空です",
      );
    }
    if (Buffer.byteLength(input.csvText, "utf8") > maxBytes) {
      throw new SheetParseError("INPUT_TOO_LARGE", "ファイルが大きすぎます");
    }
    const r = parseCsv(input.csvText);
    if (r.headers.length === 0) {
      throw new SheetParseError("NO_HEADER", "ヘッダ行を読み取れませんでした");
    }
    assertSafeHeaders(r.headers);
    return { format: "csv", ...r };
  }
  if (fmt === "xlsx") {
    if (typeof input.xlsxBase64 !== "string" || input.xlsxBase64.length === 0) {
      throw new SheetParseError(
        "INVALID_INPUT",
        "Excelバイナリが空です",
      );
    }
    // base64 長からデコード後サイズを見積もり、巨大入力は XLSX.read 前に弾く。
    const estimatedBytes = Math.floor((input.xlsxBase64.length * 3) / 4);
    if (estimatedBytes > maxBytes) {
      throw new SheetParseError("INPUT_TOO_LARGE", "ファイルが大きすぎます");
    }
    return parseXlsxFromBase64(input.xlsxBase64, input.formattedTextHeaders);
  }
  throw new SheetParseError(
    "UNSUPPORTED_FORMAT",
    "対応形式は .csv / .xlsx のみです",
  );
}

const XLSX_SHEET_TO_JSON_OPTS = {
  header: 1 as const,
  defval: "",
  blankrows: false,
};

/**
 * 二パス AOA（raw 値 / 整形済みテキスト）を 1 行オブジェクト配列へ統合する純関数。
 *
 * - `formattedTextHeaders` に一致するヘッダ列だけ `aoaFmt`（.w 文字列）を採用し、
 *   それ以外の列は `aoaRaw`（生値）を使う（他列に指数表記などの影響を出さない）。
 * - 整列ガード: `aoaFmt` が null、行数不一致、いずれかの行長不一致のいずれかなら
 *   formatted を**まるごと放棄**し全列 raw へフォールバックする（throw せず・最悪でも
 *   #171 の単一パス挙動＝先頭0喪失セルは drop に帰着）。
 *
 * headers は `aoaRaw[0]` から抽出する。空行（全セル空文字）は raw ベースで除外する。
 */
export function buildXlsxRows(
  aoaRaw: unknown[][],
  aoaFmt: unknown[][] | null,
  formattedTextHeaders: ReadonlySet<string>,
): { headers: string[]; rows: Record<string, string>[] } {
  const headerRow = aoaRaw[0] ?? [];
  const headers = headerRow.map((v) => cellToString(v).trim());

  const wantFormatted =
    formattedTextHeaders.size > 0 &&
    headers.some((h) => formattedTextHeaders.has(h));
  // 整列ガード（行数・各行の行長が raw と一致する時のみ formatted を信頼）
  const formattedUsable =
    wantFormatted &&
    aoaFmt != null &&
    aoaFmt.length === aoaRaw.length &&
    aoaRaw.every((r, i) => (aoaFmt[i]?.length ?? -1) === (r?.length ?? 0));

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < aoaRaw.length; i++) {
    const rawRow = aoaRaw[i] ?? [];
    const fmtRow = formattedUsable ? aoaFmt![i] : undefined;
    const values = headers.map((_, j) => {
      const useFmt = fmtRow != null && formattedTextHeaders.has(headers[j]);
      const cell = useFmt ? fmtRow[j] : rawRow[j];
      return cellToString(cell).trim();
    });
    // 全セルが空白の行はスキップ
    if (values.every((v) => v === "")) continue;
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j];
    }
    rows.push(record);
  }
  return { headers, rows };
}

function parseXlsxFromBase64(
  base64: string,
  formattedTextHeaders?: ReadonlySet<string>,
): SheetParseResult {
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
  const aoaRaw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    ...XLSX_SHEET_TO_JSON_OPTS,
    raw: true,
  });
  if (!aoaRaw || aoaRaw.length === 0) {
    throw new SheetParseError("EMPTY_SHEET", "Excelシートが空です");
  }
  const headerRow = aoaRaw[0] ?? [];
  const headers = headerRow.map((v) => cellToString(v).trim());
  if (headers.every((h) => h === "")) {
    throw new SheetParseError("NO_HEADER", "Excelの1行目が空です");
  }
  // プロトタイプ汚染系の危険な列名は行生成前に弾く（多層防御）。
  assertSafeHeaders(headers);
  // 郵便番号など指定ヘッダ列がある時だけ第2パス（raw:false=.w）を取得する。
  // それ以外は従来通り単一パス＝挙動・性能を変えない。
  const wantFormatted =
    !!formattedTextHeaders &&
    formattedTextHeaders.size > 0 &&
    headers.some((h) => formattedTextHeaders.has(h));
  const aoaFmt = wantFormatted
    ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        ...XLSX_SHEET_TO_JSON_OPTS,
        raw: false,
      })
    : null;

  const { rows } = buildXlsxRows(
    aoaRaw,
    aoaFmt,
    formattedTextHeaders ?? new Set<string>(),
  );
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
