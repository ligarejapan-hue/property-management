import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  detectFileFormat,
  parseSheet,
  cellToString,
  SheetParseError,
} from "../sheet-parser";
import { parseReceptionRows, parseOwnerRows } from "../reception-owner-match";

// ---------- detectFileFormat ----------

describe("detectFileFormat", () => {
  it("csv 拡張子を csv として識別", () => {
    expect(detectFileFormat("data.csv")).toBe("csv");
    expect(detectFileFormat("DATA.CSV")).toBe("csv");
    expect(detectFileFormat("受付帳.tsv")).toBe("csv");
    expect(detectFileFormat("x.txt")).toBe("csv");
  });
  it("xlsx 拡張子を xlsx として識別", () => {
    expect(detectFileFormat("book.xlsx")).toBe("xlsx");
    expect(detectFileFormat("Book.XLSX")).toBe("xlsx");
  });
  it("未対応拡張子は unknown", () => {
    expect(detectFileFormat("data.xls")).toBe("unknown");
    expect(detectFileFormat("data.pdf")).toBe("unknown");
    expect(detectFileFormat("")).toBe("unknown");
    expect(detectFileFormat(null)).toBe("unknown");
  });
});

// ---------- cellToString ----------

describe("cellToString", () => {
  it("整数は指数表記にならず生文字列化", () => {
    expect(cellToString(1300012345678)).toBe("1300012345678");
    expect(cellToString(0)).toBe("0");
    expect(cellToString(-5)).toBe("-5");
  });
  it("小数は可能なら短く、指数表記は固定桁に展開", () => {
    expect(cellToString(1.5)).toBe("1.5");
    const big = cellToString(1.23e20);
    // 指数表記 "e" が含まれないことを確認
    expect(/e/i.test(big)).toBe(false);
  });
  it("boolean は TRUE/FALSE", () => {
    expect(cellToString(true)).toBe("TRUE");
    expect(cellToString(false)).toBe("FALSE");
  });
  it("Date は ISO 日付", () => {
    const d = new Date(Date.UTC(2026, 3, 23));
    expect(cellToString(d)).toBe("2026-04-23");
  });
  it("null/undefined は空文字", () => {
    expect(cellToString(null)).toBe("");
    expect(cellToString(undefined)).toBe("");
  });
  it("文字列はそのまま", () => {
    expect(cellToString("1-2-3")).toBe("1-2-3");
  });
});

// ---------- parseSheet: csv ----------

describe("parseSheet (csv)", () => {
  it("ヘッダ + 行をオブジェクトに変換", () => {
    const csv = "住所,地番\n東京都千代田区,1-2\n東京都港区,3-4\n";
    const r = parseSheet({ fileName: "props.csv", csvText: csv });
    expect(r.format).toBe("csv");
    expect(r.headers).toEqual(["住所", "地番"]);
    expect(r.rows).toEqual([
      { 住所: "東京都千代田区", 地番: "1-2" },
      { 住所: "東京都港区", 地番: "3-4" },
    ]);
  });
  it("csvText 空なら INVALID_INPUT", () => {
    expect(() => parseSheet({ fileName: "a.csv", csvText: "" })).toThrowError(
      SheetParseError,
    );
  });
});

// ---------- parseSheet: xlsx round-trip ----------

function makeXlsxBase64(aoa: unknown[][]): string {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buf.toString("base64");
}

describe("parseSheet (xlsx)", () => {
  it("ヘッダ + 行を CSV と同じ形に正規化する", () => {
    const base64 = makeXlsxBase64([
      ["住所", "地番"],
      ["東京都千代田区", "1-2"],
      ["東京都港区", "3-4"],
    ]);
    const r = parseSheet({ fileName: "props.xlsx", xlsxBase64: base64 });
    expect(r.format).toBe("xlsx");
    expect(r.headers).toEqual(["住所", "地番"]);
    expect(r.rows).toEqual([
      { 住所: "東京都千代田区", 地番: "1-2" },
      { 住所: "東京都港区", 地番: "3-4" },
    ]);
  });

  it("数値セルが指数表記にならない（不動産番号13桁整数）", () => {
    const base64 = makeXlsxBase64([
      ["不動産番号", "地番"],
      [1300012345678, "1-2"],
    ]);
    const r = parseSheet({ fileName: "props.xlsx", xlsxBase64: base64 });
    expect(r.rows[0]["不動産番号"]).toBe("1300012345678");
  });

  it("空行はスキップされる", () => {
    const base64 = makeXlsxBase64([
      ["住所", "地番"],
      ["", ""],
      ["東京都港区", "3-4"],
    ]);
    const r = parseSheet({ fileName: "a.xlsx", xlsxBase64: base64 });
    expect(r.rows).toHaveLength(1);
  });

  it("ヘッダ行のみは rows=0", () => {
    const base64 = makeXlsxBase64([["住所", "地番"]]);
    const r = parseSheet({ fileName: "a.xlsx", xlsxBase64: base64 });
    expect(r.headers).toEqual(["住所", "地番"]);
    expect(r.rows).toEqual([]);
  });

  it("xlsxBase64 空なら INVALID_INPUT", () => {
    expect(() =>
      parseSheet({ fileName: "a.xlsx", xlsxBase64: "" }),
    ).toThrowError(SheetParseError);
  });

});

// ---------- parseSheet: UNSUPPORTED_FORMAT ----------

describe("parseSheet (unsupported format)", () => {
  it(".xls は UNSUPPORTED_FORMAT", () => {
    try {
      parseSheet({ fileName: "a.xls", xlsxBase64: "AA==" });
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SheetParseError);
      expect((e as SheetParseError).code).toBe("UNSUPPORTED_FORMAT");
    }
  });
});

// ---------- parseSheet + reception match key parity ----------

/**
 * 受付帳 xlsx で 0-indexed F(5)/H(7)/I(8)/J(9)/K(10) に値が並ぶことを確認。
 * csv / xlsx で matchKey が同じになることが本テストの目的。
 */
function toPositionalRows(
  headers: string[],
  rows: readonly Record<string, string>[],
): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

describe("reception rows: csv と xlsx で matchKey が同じ", () => {
  // A..M の 13 列。index 5=F, 7=H, 8=I, 9=J, 10=K
  const headers = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
  const dataRow = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "土地",
    "g",
    "東京都",
    "港区",
    "六本木",
    "1-2-3",
    "l",
    "m",
  ];

  it("csv → H〜K 連結キー", () => {
    const csv = headers.join(",") + "\n" + dataRow.join(",") + "\n";
    const sheet = parseSheet({ fileName: "受付帳.csv", csvText: csv });
    const parsed = parseReceptionRows(
      toPositionalRows(sheet.headers, sheet.rows),
    );
    expect(parsed[0].matchKey).toBe("東京都港区六本木1-2-3");
    expect(parsed[0].lotNumber).toBe("1-2-3");
    expect(parsed[0].buildingNumber).toBeNull();
  });

  it("xlsx → 同じ matchKey（数値混在でも崩れない）", () => {
    const base64 = makeXlsxBase64([headers, dataRow]);
    const sheet = parseSheet({ fileName: "受付帳.xlsx", xlsxBase64: base64 });
    const parsed = parseReceptionRows(
      toPositionalRows(sheet.headers, sheet.rows),
    );
    expect(parsed[0].matchKey).toBe("東京都港区六本木1-2-3");
    expect(parsed[0].lotNumber).toBe("1-2-3");
    expect(parsed[0].buildingNumber).toBeNull();
  });

  it("xlsx + F=建物 → buildingNumber にルーティング", () => {
    const row = [...dataRow];
    row[5] = "建物";
    const base64 = makeXlsxBase64([headers, row]);
    const sheet = parseSheet({ fileName: "受付帳.xlsx", xlsxBase64: base64 });
    const parsed = parseReceptionRows(
      toPositionalRows(sheet.headers, sheet.rows),
    );
    expect(parsed[0].lotNumber).toBeNull();
    expect(parsed[0].buildingNumber).toBe("1-2-3");
  });

  it("xlsx + F=区分 → buildingNumber にルーティング（csv と同じ）", () => {
    const row = [...dataRow];
    row[5] = "区分";
    const base64 = makeXlsxBase64([headers, row]);
    const sheet = parseSheet({ fileName: "受付帳.xlsx", xlsxBase64: base64 });
    const parsed = parseReceptionRows(
      toPositionalRows(sheet.headers, sheet.rows),
    );
    expect(parsed[0].buildingNumber).toBe("1-2-3");
    expect(parsed[0].lotNumber).toBeNull();
  });
});

describe("owner rows: csv と xlsx で matchKey が同じ", () => {
  const headers = ["氏名", "住所", "連結キー", "部屋番号"];
  const dataRow = ["山田 太郎", "東京都港区六本木1-2-3", "東京都港区六本木1-2-3", "301"];
  it("csv/xlsx 両方で C列正規化キーが一致", () => {
    const csv = headers.join(",") + "\n" + dataRow.join(",") + "\n";
    const csvSheet = parseSheet({ fileName: "所有者.csv", csvText: csv });
    const csvOwners = parseOwnerRows(
      csvSheet.headers,
      toPositionalRows(csvSheet.headers, csvSheet.rows),
    );
    const base64 = makeXlsxBase64([headers, dataRow]);
    const xSheet = parseSheet({ fileName: "所有者.xlsx", xlsxBase64: base64 });
    const xOwners = parseOwnerRows(
      xSheet.headers,
      toPositionalRows(xSheet.headers, xSheet.rows),
    );
    expect(csvOwners[0].matchKey).toBe(xOwners[0].matchKey);
    expect(csvOwners[0].name).toBe("山田 太郎");
    expect(xOwners[0].name).toBe("山田 太郎");
    expect(csvOwners[0].roomNo).toBe("301");
    expect(xOwners[0].roomNo).toBe("301");
  });
});
