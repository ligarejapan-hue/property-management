/**
 * XLSX 郵便番号列の formatted-text 保持（21-C タスク4）。
 *
 * 背景: #171 は XLSX 数値セルで先頭0が落ちた郵便番号を fail-closed で drop する。
 * 本タスクは「郵便番号ヘッダ列だけ」セルの formatted text（.w）を採用し、
 * 郵便書式付き数値セル（例: 書式 0000000・値 100492 → 表示 0100492）の先頭0を回収する。
 * General 数値（Excel 時点で 0 喪失）は回収せず drop を維持（誤補正禁止）。
 *
 * - buildXlsxRows: 二パス AOA を統合する純関数。整列不一致時は formatted を放棄し raw へフォールバック。
 * - parseSheet(xlsx): formattedTextHeaders を渡すと郵便番号列のみ .w を採用。他列・CSV は不変。
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseSheet, buildXlsxRows } from "../sheet-parser";

// ---------------------------------------------------------------------------
// buildXlsxRows（純関数・整列ガード）
// ---------------------------------------------------------------------------

describe("buildXlsxRows", () => {
  const headers = ["住所", "郵便番号", "地番"];
  // raw:true 相当（生値）
  const aoaRaw: unknown[][] = [
    headers,
    ["秋田A", 100492, 123456789012],
    ["秋田B", "010-0492", "12-3"],
  ];
  // raw:false 相当（.w 文字列）— 郵便番号は先頭0回収、地番は指数化
  const aoaFmt: unknown[][] = [
    headers,
    ["秋田A", "0100492", "1.23457E+11"],
    ["秋田B", "010-0492", "12-3"],
  ];

  it("郵便番号ヘッダ列は formatted(.w) 値を採用する", () => {
    const { rows } = buildXlsxRows(aoaRaw, aoaFmt, new Set(["郵便番号"]));
    expect(rows[0]["郵便番号"]).toBe("0100492");
  });

  it("非郵便番号列(地番)は formatted が違っても raw を使う（他列分離）", () => {
    const { rows } = buildXlsxRows(aoaRaw, aoaFmt, new Set(["郵便番号"]));
    expect(rows[0]["地番"]).toBe("123456789012"); // 指数化しない
  });

  it("formattedTextHeaders が空なら全列 raw", () => {
    const { rows } = buildXlsxRows(aoaRaw, aoaFmt, new Set());
    expect(rows[0]["郵便番号"]).toBe("100492"); // raw 生値の文字列化
  });

  it("aoaFmt が null なら全列 raw", () => {
    const { rows } = buildXlsxRows(aoaRaw, null, new Set(["郵便番号"]));
    expect(rows[0]["郵便番号"]).toBe("100492");
  });

  it("整列不一致(行数違い)は formatted を放棄し raw へフォールバック", () => {
    const shortFmt: unknown[][] = [headers, ["秋田A", "0100492", "1.23457E+11"]];
    const { rows } = buildXlsxRows(aoaRaw, shortFmt, new Set(["郵便番号"]));
    expect(rows).toHaveLength(2);
    expect(rows[0]["郵便番号"]).toBe("100492"); // #171 と同一挙動
  });

  it("整列不一致(行長違い)は formatted を放棄し raw へフォールバック", () => {
    const ragged: unknown[][] = [
      headers,
      ["秋田A", "0100492"], // 列が1つ足りない
      ["秋田B", "010-0492", "12-3"],
    ];
    const { rows } = buildXlsxRows(aoaRaw, ragged, new Set(["郵便番号"]));
    expect(rows[0]["郵便番号"]).toBe("100492");
  });

  it("headers と空行スキップは raw ベースで維持される", () => {
    const withBlank: unknown[][] = [
      headers,
      ["", "", ""],
      ["秋田B", "010-0492", "12-3"],
    ];
    const fmtBlank: unknown[][] = [
      headers,
      ["", "", ""],
      ["秋田B", "010-0492", "12-3"],
    ];
    const { headers: h, rows } = buildXlsxRows(withBlank, fmtBlank, new Set(["郵便番号"]));
    expect(h).toEqual(headers);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseSheet(xlsx) 統合 — 実 XLSX を書式付きで生成
// ---------------------------------------------------------------------------

/** 指定セルに type/value/format を設定した XLSX を base64 で返す。 */
function makeXlsxWithCells(
  cells: Record<string, { t: string; v: unknown; z?: string }>,
  ref: string,
): string {
  const ws: Record<string, unknown> = { "!ref": ref };
  for (const [addr, c] of Object.entries(cells)) {
    ws[addr] = c.z ? { t: c.t, v: c.v, z: c.z } : { t: c.t, v: c.v };
  }
  const wb = { SheetNames: ["Sheet1"], Sheets: { Sheet1: ws } };
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buf.toString("base64");
}

describe("parseSheet(xlsx) — 郵便番号 formatted-text", () => {
  // 住所 / 郵便番号 / 地番 の3列・4データ行（保存形態違い）
  const base64 = makeXlsxWithCells(
    {
      A1: { t: "s", v: "住所" },
      B1: { t: "s", v: "郵便番号" },
      C1: { t: "s", v: "地番" },
      // 郵便書式付き数値 → .w=0100492（回収対象）
      A2: { t: "s", v: "秋田A" },
      B2: { t: "n", v: 100492, z: "0000000" },
      C2: { t: "n", v: 123456789012 },
      // ハイフン入り書式の数値 → .w=010-0492（normalizeで0100492化は route 側）
      A3: { t: "s", v: "秋田B" },
      B3: { t: "n", v: 100492, z: "000-0000" },
      C3: { t: "s", v: "12-3" },
      // General 数値（Excel時点で0喪失）→ .w=100492（回収不能・drop維持）
      A4: { t: "s", v: "秋田C" },
      B4: { t: "n", v: 100492 },
      C4: { t: "n", v: 5 },
      // テキストセル
      A5: { t: "s", v: "秋田D" },
      B5: { t: "s", v: "010-0492" },
      C5: { t: "n", v: 6 },
    },
    "A1:C5",
  );

  it("formattedTextHeaders 指定時: 郵便書式数値の先頭0を .w で回収", () => {
    const r = parseSheet({
      fileName: "x.xlsx",
      xlsxBase64: base64,
      formattedTextHeaders: new Set(["郵便番号"]),
    });
    expect(r.rows[0]["郵便番号"]).toBe("0100492");
    // ハイフン書式は .w のまま（route の normalize 前段）
    expect(r.rows[1]["郵便番号"]).toBe("010-0492");
    // General 数値は回収不能のまま（drop は route 側で）
    expect(r.rows[2]["郵便番号"]).toBe("100492");
    // テキストは保持
    expect(r.rows[3]["郵便番号"]).toBe("010-0492");
  });

  it("他列(地番)は formattedTextHeaders 指定時も raw 維持（指数化しない）", () => {
    const r = parseSheet({
      fileName: "x.xlsx",
      xlsxBase64: base64,
      formattedTextHeaders: new Set(["郵便番号"]),
    });
    expect(r.rows[0]["地番"]).toBe("123456789012");
  });

  it("formattedTextHeaders 未指定時は従来挙動（単一パス・郵便書式数値も 100492）", () => {
    const r = parseSheet({ fileName: "x.xlsx", xlsxBase64: base64 });
    expect(r.rows[0]["郵便番号"]).toBe("100492");
    expect(r.rows[0]["地番"]).toBe("123456789012");
  });
});
