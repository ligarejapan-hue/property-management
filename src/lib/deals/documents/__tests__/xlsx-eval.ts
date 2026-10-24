import { expect } from "vitest";
import type ExcelJS from "exceljs";

/** 書類の Excel のテスト用: A列のラベルで行を探す・数式を計算し直す(資金計画表・事業計画書で共通)。 */

export type FormulaValue = { formula: string; result: number };
export const isFormula = (v: unknown): v is FormulaValue => !!v && typeof v === "object" && "formula" in v;

/** A列のラベルで行を探す。 */
export function rowOf(ws: ExcelJS.Worksheet, label: string): number {
  let found = 0;
  ws.eachRow((row, n) => { if (!found && row.getCell(1).value === label) found = n; });
  if (!found) throw new Error(`行が無い: ${label}`);
  return found;
}

/**
 * テスト用の小さな数式の評価(Excel で計算し直したときと同じ値になるかを確かめる)。
 * 使う形は SUM(範囲)・ROUNDDOWN(x,0)・TRUNC(x,桁)・PMT(r,n,pv)・四則・セル参照だけ。
 */
export function evaluate(ws: ExcelJS.Worksheet, addr: string): number {
  const v = ws.getCell(addr).value;
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  if (!isFormula(v)) throw new Error(`数式でも数でもない: ${addr}`);
  let expr = v.formula.replace(/SUM\(([A-Z]+)(\d+):\1(\d+)\)/g, (_, col: string, a: string, b: string) => {
    const xs: number[] = [];
    for (let r = Number(a); r <= Number(b); r++) xs.push(evaluate(ws, `${col}${r}`));
    return `(${xs.join("+")})`;
  });
  expr = expr.replace(/\$?([A-Z]+)\$?(\d+)/g, (_, col: string, r: string) => `(${evaluate(ws, `${col}${r}`)})`);
  return parseExpr(expr);
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  ROUNDDOWN: (x) => Math.trunc(x),
  /** TRUNC(x, 桁): 0 に向けて桁の下を切り捨て。 */
  TRUNC: (x, d = 0) => Math.trunc(x * 10 ** d) / 10 ** d,
  PMT: (r, n, pv) => (r === 0 ? -pv / n : (-pv * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)),
};

/** 四則・単項マイナス・かっこ・関数呼び出しだけの再帰下降。 */
function parseExpr(src: string): number {
  const toks = src.match(/\d+(?:\.\d+)?(?:e-?\d+)?|[A-Z]+|[-+*/(),]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = (t?: string) => {
    const x = toks[i++];
    if (t !== undefined && x !== t) throw new Error(`式が読めない: ${src}`);
    return x;
  };
  const primary = (): number => {
    const t = take();
    if (t === "-") return -primary();
    if (t === "(") { const v = sum(); take(")"); return v; }
    if (/^[A-Z]+$/.test(t)) {
      take("(");
      const args = [sum()];
      while (peek() === ",") { take(); args.push(sum()); }
      take(")");
      return FUNCS[t](...args);
    }
    return Number(t);
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") v = take() === "*" ? v * primary() : v / primary();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i !== toks.length) throw new Error(`式の残り: ${src}`);
  return v;
}

/** 数式が入っていて、入れた結果がサーバーの値と一致し、計算し直しても同じ値になる。 */
export function expectFormula(ws: ExcelJS.Worksheet, addr: string, expected: number, pattern: RegExp) {
  const v = ws.getCell(addr).value;
  expect(isFormula(v), addr).toBe(true);
  expect((v as FormulaValue).formula).toMatch(pattern);
  expect((v as FormulaValue).result).toBe(expected);
  expect(evaluate(ws, addr)).toBe(expected);
}

