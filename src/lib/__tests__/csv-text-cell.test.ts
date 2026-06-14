/**
 * 地番・家屋番号など「Excel が日付に自動変換してしまう値」を、テキストとして固定出力し、
 * 再取込で元値へ戻すための wrap/unwrap ヘルパの単体テスト。
 *
 * 採用方式: Excel テキスト数式 `="<値>"`。
 *  - Excel は CSV を開く際にこの数式を評価し「文字列リテラル」として表示する（4-2 / 1-2-3 を
 *    日付化しない）。先頭 ' を付ける方式と違い、値に余計な文字が残らない（apostrophe は
 *    CSV ファイルを開いた Excel では除去されず "'4-2" と表示されてしまうため不採用）。
 *  - 値全体を文字列リテラル化するため、=1+1 等の数式起動文字も中和される（formula injection 対策）。
 *  - 取込側は unwrap で `="4-2"` → `4-2` に戻すため、出力→再取込の往復で元値に一致する。
 */
import { describe, it, expect } from "vitest";
import {
  wrapCsvTextCell,
  unwrapCsvTextCell,
  sanitizeCsvCellForExcel,
  escapeCsvField,
} from "@/lib/csv-encode";

describe("wrapCsvTextCell（Excel テキスト数式でのテキスト固定）", () => {
  it("通常値（地番/家屋番号）を =\"値\" 形式で包む", () => {
    expect(wrapCsvTextCell("4-2")).toBe('="4-2"');
    expect(wrapCsvTextCell("1-2-3")).toBe('="1-2-3"');
    expect(wrapCsvTextCell("12-3")).toBe('="12-3"');
  });

  it("空値・null・undefined は空のまま（余計な文字を足さない）", () => {
    expect(wrapCsvTextCell("")).toBe("");
    expect(wrapCsvTextCell(null)).toBe("");
    expect(wrapCsvTextCell(undefined)).toBe("");
  });

  it("値そのもの（桁・ハイフン）は変えない＝整形しない", () => {
    // 郵便番号のような NNN-NNNN 整形はしない。地番/家屋番号は表記をいじらない。
    expect(wrapCsvTextCell("0100492")).toBe('="0100492"');
    expect(wrapCsvTextCell("１２３")).toBe('="１２３"'); // 全角もそのまま
  });

  it("値内のダブルクオートは二重化して数式リテラルを壊さない", () => {
    expect(wrapCsvTextCell('a"b')).toBe('="a""b"');
  });

  it("formula injection: =1+1 等は文字列リテラル化され数式実行されない", () => {
    expect(wrapCsvTextCell("=1+1")).toBe('="=1+1"');
    expect(wrapCsvTextCell("+SUM(A1:A2)")).toBe('="+SUM(A1:A2)"');
    expect(wrapCsvTextCell("-10")).toBe('="-10"');
    expect(wrapCsvTextCell("@cmd")).toBe('="@cmd"');
  });
});

describe("unwrapCsvTextCell（テキスト数式セルを元値へ戻す）", () => {
  it("=\"値\" を内側の値へ戻す", () => {
    expect(unwrapCsvTextCell('="4-2"')).toBe("4-2");
    expect(unwrapCsvTextCell('="1-2-3"')).toBe("1-2-3");
    expect(unwrapCsvTextCell('="0100492"')).toBe("0100492");
  });

  it("二重化されたダブルクオートを1つに戻す", () => {
    expect(unwrapCsvTextCell('="a""b"')).toBe('a"b');
  });

  it("テキスト数式でない通常値はそのまま（既存CSV/手入力を壊さない）", () => {
    expect(unwrapCsvTextCell("4-2")).toBe("4-2");
    expect(unwrapCsvTextCell("")).toBe("");
    expect(unwrapCsvTextCell("東京都千代田区1-1")).toBe("東京都千代田区1-1");
    // 末尾が " で閉じていない / = で始まらない不完全な値は触らない
    expect(unwrapCsvTextCell('="4-2')).toBe('="4-2');
    expect(unwrapCsvTextCell('"4-2"')).toBe('"4-2"');
  });
});

describe("往復（wrap → CSV エンコード/デコード相当 → unwrap）で元値に一致", () => {
  // encodeCsv は escapeCsvField を通すため、wrap 済みセルが RFC quoting されても
  // 取込側パーサ（"" → " 復元）と unwrap で元値に戻ることを確認する。
  function csvEscapeThenUnescape(cell: string): string {
    // export 側の RFC quoting
    const onDisk = escapeCsvField(cell);
    // 取込側パーサの unquote（csv-parser と等価: 外側 " 除去 + "" → "）
    let inner = onDisk;
    if (inner.startsWith('"') && inner.endsWith('"')) {
      inner = inner.slice(1, -1).replace(/""/g, '"');
    }
    return inner;
  }

  for (const value of ["4-2", "1-2-3", "12-3", "0100492", "=1+1", 'a"b', "@x"]) {
    it(`値「${value}」が往復で一致する`, () => {
      const wrapped = wrapCsvTextCell(value);
      const roundTripped = unwrapCsvTextCell(csvEscapeThenUnescape(wrapped));
      expect(roundTripped).toBe(value);
    });
  }

  it("wrap 済みセルは二重 sanitize しても壊れない（= 始まりでも再度 ' を付けない運用）", () => {
    // route 側は wrap 済みセルに sanitizeCsvCellForExcel を重ねない設計だが、
    // 仮に重ねても =".." は ' 付与されるだけで、unwrap 前に ' を剥がせば復元可能なことを確認。
    const wrapped = wrapCsvTextCell("4-2"); // ="4-2"
    const doubled = sanitizeCsvCellForExcel(wrapped); // '="4-2"
    // 先頭 ' を剥がせば元の wrap に戻る
    expect(doubled.replace(/^'/, "")).toBe(wrapped);
  });
});
