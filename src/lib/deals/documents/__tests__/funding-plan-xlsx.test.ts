import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildFundingPlanXlsx } from "../funding-plan-xlsx";
import { fundingPlanCalc, type FundingPlanCalc } from "../../calc/funding-plan";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT, type DealDocText } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS, type FundingInputs } from "../../funding-schema";
import type { DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-05-01T01:00:00.000Z", contractPlace: null, settlementAt: "2026-07-01T01:00:00.000Z", settlementPlace: null,
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション", roomNo: "101", address: "架空県架空市1-2-3" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, managementFee: 20_000, repairReserve: 10_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [], fundingPlan: DEFAULT_FUNDING_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空知事(1)第00000号", tel: "000-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市" };

const calcOf = (i: FundingInputs, d: DealView = deal) =>
  fundingPlanCalc(d, computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24"), i, rateRows);

async function sheetOf(i: FundingInputs, d: DealView = deal, text?: DealDocText): Promise<{ ws: ExcelJS.Worksheet; calc: FundingPlanCalc }> {
  const calc = calcOf(i, d);
  const buf = await buildFundingPlanXlsx({ deal: d, inputs: i, calc, company, issuedOn: "2026-10-24", text });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return { ws: wb.worksheets[0], calc };
}

type FormulaValue = { formula: string; result: number };
const isFormula = (v: unknown): v is FormulaValue => !!v && typeof v === "object" && "formula" in v;

/** A列のラベルで行を探す。 */
function rowOf(ws: ExcelJS.Worksheet, label: string): number {
  let found = 0;
  ws.eachRow((row, n) => { if (!found && row.getCell(1).value === label) found = n; });
  if (!found) throw new Error(`行が無い: ${label}`);
  return found;
}

/**
 * テスト用の小さな数式の評価(Excel で計算し直したときと同じ値になるかを確かめる)。
 * 使う形は SUM(範囲)・ROUNDDOWN(x,0)・PMT(r,n,pv)・四則・セル参照だけ。
 */
function evaluate(ws: ExcelJS.Worksheet, addr: string): number {
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
function expectFormula(ws: ExcelJS.Worksheet, addr: string, expected: number, pattern: RegExp) {
  const v = ws.getCell(addr).value;
  expect(isFormula(v), addr).toBe(true);
  expect((v as FormulaValue).formula).toMatch(pattern);
  expect((v as FormulaValue).result).toBe(expected);
  expect(evaluate(ws, addr)).toBe(expected);
}

describe("資金計画表の Excel", () => {
  const purchase: FundingInputs = {
    ...DEFAULT_FUNDING_INPUTS, customerName: "=HYPERLINK(\"x\") 架空",
    purchase: {
      ...DEFAULT_FUNDING_INPUTS.purchase, loanAmount: 40_000_000, scrivenerFee: 100_000, fireInsurance: 50_000,
      loans: [{ annualRateBp: 100, years: 35 }, { annualRateBp: 0, years: 30 }, { annualRateBp: 175, years: 25 }],
    },
  };

  it("購入: 諸費用の合計・必要な資金・自己資金は数式で、値はサーバーの計算と一致する", async () => {
    const { ws, calc } = await sheetOf(purchase);
    expect(ws.getCell("A1").value).toBe("資金計画表(ご購入)");
    expectFormula(ws, `B${rowOf(ws, "諸費用の合計")}`, calc.purchase.costsTotal, /^SUM\(B\d+:B\d+\)$/);
    expectFormula(ws, `B${rowOf(ws, "必要な資金の合計")}`, calc.purchase.total!, /^B\d+\+B\d+$/);
    expectFormula(ws, `B${rowOf(ws, "自己資金")}`, calc.purchase.ownFunds!, /^B\d+-B\d+$/);
    expect(ws.getCell(`B${rowOf(ws, "借入額")}`).value).toBe(40_000_000);
  });

  it("購入: 月返済額は ROUNDDOWN(PMT(...),0)・金利0も含め、パターンごとにサーバーと一致する", async () => {
    const { ws, calc } = await sheetOf(purchase);
    const r = rowOf(ws, "月々の返済額");
    ["B", "C", "D"].forEach((col, i) => {
      expectFormula(ws, `${col}${r}`, calc.purchase.loans[i].monthly, /^ROUNDDOWN\(PMT\([B-D]\d+\/12,[B-D]\d+\*12,-\$B\$\d+\),0\)$/);
    });
    expect(calc.purchase.loans[0].monthly).toBe(112_914);
    // 区分は管理費などを足した月々の合計も数式。
    const t = rowOf(ws, "月々のお支払いの合計");
    ["B", "C", "D"].forEach((col, i) => expectFormula(ws, `${col}${t}`, calc.purchase.loans[i].monthlyTotal, /^[B-D]\d+\+[B-D]\d+$/));
  });

  it("文字は文字のまま(お客様名が数式として入らない)・空欄の行は出さない", async () => {
    const { ws } = await sheetOf(purchase);
    expect(ws.getCell("A2").value).toBe("=HYPERLINK(\"x\") 架空 様");
    let formulas = 0;
    ws.eachRow((row) => row.eachCell((c) => { if (isFormula(c.value) && /HYPERLINK/.test(c.value.formula)) formulas++; }));
    expect(formulas).toBe(0);
    expect(() => rowOf(ws, "ローン保証料")).toThrow();
  });

  it("取引の設定の文面: あいさつ文は物件の下、注意事項は会社名の上に1行ずつ・文字のまま", async () => {
    const { ws } = await sheetOf(purchase, deal, { greeting: "このたびは\n=SUM(1,2)", notes: "金利は変わります\n概算です" });
    const values: unknown[] = [];
    ws.eachRow((row) => values.push(row.getCell(1).value));
    const at = (v: string) => values.indexOf(v);
    expect(at("このたびは")).toBeGreaterThan(at("所在 架空県架空市1-2-3"));
    expect(at("=SUM(1,2)")).toBe(at("このたびは") + 1);
    expect(at("金利は変わります")).toBeGreaterThan(at("自己資金"));
    expect(at("概算です")).toBe(at("金利は変わります") + 1);
    expect(at("架空不動産株式会社")).toBeGreaterThan(at("概算です"));
    let formulas = 0;
    ws.eachRow((row) => row.eachCell((c) => { if (isFormula(c.value) && /SUM\(1,2\)/.test(c.value.formula)) formulas++; }));
    expect(formulas).toBe(0);
    // 文面が無ければ行も増えない
    const count = (s: ExcelJS.Worksheet) => { let n = 0; s.eachRow(() => n++); return n; };
    expect(count((await sheetOf(purchase, deal, { greeting: null, notes: null })).ws)).toBe(count((await sheetOf(purchase)).ws));
  });

  it("土地: 保存登記・火災保険の行が無く、区分の月々の合計も無い", async () => {
    const land = { ...deal, propertyKind: "land" };
    const { ws, calc } = await sheetOf(purchase, land);
    expect(() => rowOf(ws, "火災保険")).toThrow();
    expect(() => rowOf(ws, "月々のお支払いの合計")).toThrow();
    expectFormula(ws, `B${rowOf(ws, "諸費用の合計")}`, calc.purchase.costsTotal, /^SUM/);
  });

  it("価格が無いときは合計・自己資金に数式を入れない(サーバーの計算も空)", async () => {
    const { ws, calc } = await sheetOf(purchase, { ...deal, price: null });
    expect(calc.purchase.total).toBeNull();
    expect(ws.getCell(`B${rowOf(ws, "必要な資金の合計")}`).value).toBeNull();
    expect(ws.getCell(`B${rowOf(ws, "自己資金")}`).value).toBeNull();
  });

  it("売却: 費用の合計・手取り・税引後の手取りは数式で、サーバーの計算と一致する", async () => {
    const sale: FundingInputs = {
      ...DEFAULT_FUNDING_INPUTS, mode: "sale",
      sale: { ...DEFAULT_FUNDING_INPUTS.sale, acquiredOn: "2015-03-01", acquisitionCost: 20_000_000, loanBalance: 10_000_000, surveyFee: 300_000 },
    };
    const { ws, calc } = await sheetOf(sale);
    expect(ws.getCell("A1").value).toBe("資金計画表(ご売却)");
    expectFormula(ws, `B${rowOf(ws, "費用の合計")}`, calc.sale.costsTotal, /^SUM/);
    expectFormula(ws, `B${rowOf(ws, "手取り額(税引前)")}`, calc.sale.netBeforeTax!, /^B\d+-B\d+-B\d+\+B\d+-B\d+$/);
    expect(calc.sale.tax).not.toBeNull();
    expectFormula(ws, `B${rowOf(ws, "税引後の手取り額(目安)")}`, calc.sale.netAfterTax!, /^B\d+-B\d+$/);
    let note = false;
    ws.eachRow((row) => { if (row.getCell(1).value === `※${calc.sale.taxNote}`) note = true; });
    expect(note).toBe(true);
  });
});
