/**
 * 最小限の CSV エンコーダ。
 *
 * - RFC 4180 準拠（カンマ・ダブルクオート・改行を含むフィールドはダブルクオートで囲い、内部のクオートは "" にエスケープ）
 * - 行区切りは CRLF（Excel 互換）
 * - `bom: true` で UTF-8 BOM を付与（Excel が CP932 として誤判定するのを防ぐ）
 *
 * 既存の `csv-parser.ts` (読み取り) と対をなす書き出し用ユーティリティ。
 */

export function escapeCsvField(value: string): string {
  // 区切り文字 / クオート / 改行 / 先頭末尾のスペース は囲う必要がある
  if (/["\n\r,]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * primitive / null / object / array を CSV セル向けの文字列に変換する。
 * - null / undefined → 空文字
 * - string → そのまま
 * - number / boolean → String 変換
 * - object / array → JSON.stringify（rawData に配列が混ざるケース用）
 */
export function valueToCsvString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface EncodeCsvOptions {
  /** UTF-8 BOM を先頭に付与する（Excel での文字化け回避） */
  bom?: boolean;
}

/**
 * ヘッダ + 行データ（key→value のオブジェクト配列）を CSV 文字列に変換。
 * 行データに存在しないキーは空セル扱い。
 */
export function encodeCsv(
  headers: string[],
  rows: Array<Record<string, unknown>>,
  options: EncodeCsvOptions = {},
): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsvField).join(","));
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => escapeCsvField(valueToCsvString(row[h])))
        .join(","),
    );
  }
  const body = lines.join("\r\n");
  return options.bom ? "﻿" + body : body;
}
