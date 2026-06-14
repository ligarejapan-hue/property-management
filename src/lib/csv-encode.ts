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

/**
 * CSV formula injection（Excel / Sheets が先頭文字でセルを数式扱いする問題）対策。
 *
 * Excel 互換 CSV として開かれる前提で、セル値が数式起動文字
 * （ASCII の `=` `+` `-` `@` / タブ 0x09 / CR 0x0d / LF 0x0a、および全角の
 * `＝` `＋` `－` `＠`）で始まる場合は先頭に `'` を付けて文字列として扱わせる。
 * LF は OWASP CSV Injection guidance でも危険な先頭文字として扱われるため対象に含める。
 * 全角の数式起動文字は日本語 Excel/Sheets 環境で数式と解釈され得るため対象に含める。
 * 外部入力・DB 由来の値（住所・所有者名・管理ID 等）を CSV に出す前段で無害化する用途。
 *
 * - null / undefined / 空文字は無害化せず空文字を返す（既存挙動を壊さない）
 * - 先頭に `'` を付けるだけで、文字の正規化・変換は行わない
 * - RFC quoting は別途 `escapeCsvField` が担うため、ここでは行わない
 */
export function sanitizeCsvCellForExcel(
  value: string | null | undefined,
): string {
  if (value == null || value === "") return "";
  if (/^[=+\-@\t\r\n＝＋－＠]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Excel の「日付自動変換」を防ぐためのテキスト固定セル化。
 *
 * 地番（例: 4-2）・家屋番号（例: 1-2-3）のような「数字とハイフン」の値は、Excel が CSV を
 * 開く際に日付（4月2日 等）へ勝手に変換してしまう。これを防ぐため、値を Excel の
 * **テキスト数式** `="<値>"` に包む。Excel は CSV を開く際にこの数式を評価し、内側を
 * **文字列リテラル**として表示するため、日付化されず元の表記（桁・ハイフン）が保持される。
 *
 * 方式選定（なぜ ' プレフィックスではないか）:
 *  - 先頭 `'` は「セルへ手入力する時」だけテキスト扱いになる Excel の入力規約であり、CSV を
 *    開いた場合は除去されず `'4-2` と表示されてしまう（値が汚れ、往復でも壊れる）。
 *  - `="..."` は CSV を開いた Excel が必ず文字列リテラルとして解釈するため、表示は元値どおり
 *    （余計な文字が残らない）。取込側の `unwrapCsvTextCell` で `="4-2"` → `4-2` に戻せるため
 *    出力→再取込の往復で元値に一致する。
 *
 * formula injection との両立:
 *  - 値全体を文字列リテラル化するため、`=1+1` 等の数式起動文字も「文字列」として中和される
 *    （Excel は `="=1+1"` を文字列 `=1+1` として表示する＝数式実行されない）。よって本ラップを
 *    施したセルには追加の `sanitizeCsvCellForExcel`（' 付与）を重ねる必要はない。
 *  - RFC quoting（`escapeCsvField`）は別途 `encodeCsv` が担う。ここではセル内 `"` のみ
 *    数式リテラルを壊さないよう二重化する。
 *
 * - null / undefined / 空文字は包まず空文字を返す（空は空のまま・余計な文字を足さない）。
 * - 値そのもの（桁・ハイフン・全角）は変換しない（郵便番号のような整形はしない）。
 */
export function wrapCsvTextCell(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  return `="${value.replace(/"/g, '""')}"`;
}

/**
 * `wrapCsvTextCell` の逆変換。Excel テキスト数式 `="<値>"` を内側の値へ戻す。
 *
 * - `="..."`（先頭 `="` ・末尾 `"`・最低 `=""` の長さ）にマッチした時のみ unwrap し、
 *   二重化された `""` を `"` に戻す。
 * - それ以外（通常値・手入力・既存 CSV の生 `4-2`・閉じ括弧の無い不完全値）は無改変で返す。
 *
 * 取込（CSV/XLSX パース後）に地番・家屋番号セルへ適用すると、本システムが出力した CSV を
 * 再取込しても元値に戻る。取込の一般仕様（ヘッダ→フィールド対応・正規化）は変えない。
 */
export function unwrapCsvTextCell(value: string | null | undefined): string {
  if (value == null) return "";
  if (value.length >= 3 && value.startsWith('="') && value.endsWith('"')) {
    return value.slice(2, -1).replace(/""/g, '"');
  }
  return value;
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
