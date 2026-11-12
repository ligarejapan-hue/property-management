import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildBusinessPlanXlsx } from "../business-plan-xlsx";
import { buildBusinessPlan } from "../business-plan";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS, type BusinessInputs } from "../../business-schema";
import { resolveSectionMatrix, type SectionMatrix } from "../../business-sections";
import type { DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { evaluate, expectFormula, isFormula, rowOf } from "./xlsx-eval";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
/** 架空の買取再販の取引(区分・仕入 2,000万円・決済 2026-06-01)。 */
const deal: DealView = {
  id: "d", dealNo: "2026-0009", name: "試験", businessType: "resale", tradeSide: null, status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-05-31T15:00:00.000Z", settlementPlace: null,
  price: 20_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "=HYPERLINK(\"x\")", address: "架空県架空市1-2-3", floorArea: 60.5 },
  counterpartyBroker: EMPTY_BROKER,
  assessments: { rows: [{ building: 6_000_000, land: 4_000_000, shareNum: 1, shareDen: 1 }], landRatioBp: 10000 },
  costs: { ...DEFAULT_COSTS, registrationFee: 300_000 },
  settlementTerms: { ...DEFAULT_TERMS, taxInputMode: "total", fixedAssetTax: 60_000, cityPlanningTax: 13_000, managementFee: 15_000, repairReserve: 5_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "", fax: "", email: "", hp: "", address: "" };
const inputs: BusinessInputs = {
  ...DEFAULT_BUSINESS_INPUTS,
  purchaseBrokerage: 726_000, outsourcingFee: 100_000, acquisitionTax: 200_000, settlementPaid: 50_000,
  acquisitionOthers: [{ label: "鍵交換", amount: 20_000 }], interiorCost: 3_000_000,
  saleDate: "2026-11-30", loanAmount: 18_000_000, loanRateBp: 200,
  salePrice: 28_000_000, saleBrokerage: 990_000, mortgageCancellation: 30_000,
  ownFunds: 5_000_000, loanMonths: 12, memo: "社内だけのメモ",
  comparables: [{ kind: "sold", name: "近くの架空マンション", area: 58.2, price: 27_000_000, period: "2026年8月", note: null }],
};
const ALL = resolveSectionMatrix(undefined, DEFAULT_PROPERTY_KINDS);

async function sheetOf(i: BusinessInputs = inputs, d: DealView = deal, matrix: SectionMatrix = ALL) {
  const plan = buildBusinessPlan({ deal: d, rateRows, kinds: DEFAULT_PROPERTY_KINDS, matrix, inputs: i, company, today: "2026-10-24", logo: null });
  const buf = await buildBusinessPlanXlsx({ deal: d, inputs: i, calc: plan.calc, sections: plan.sections, company, issuedOn: "2026-10-24" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const values: unknown[] = [];
  wb.worksheets[0].eachRow((row) => row.eachCell((c) => values.push(c.value)));
  return { ws: wb.worksheets[0], calc: plan.calc, values };
}
const B = (ws: ExcelJS.Worksheet, label: string) => `B${rowOf(ws, label)}`;

describe("事業計画書の Excel", () => {
  it("社内用: 承認欄と社内メモがある・銀行向けだけのセクションは無い", async () => {
    const { ws, values } = await sheetOf();
    expect(ws.getCell("A1").value).toBe("事業計画書(社内用)");
    for (const s of ["担当", "上長", "決裁者", "社内だけのメモ"]) expect(values).toContain(s);
    expect(() => rowOf(ws, "自己資金")).toThrow();
    expect(values).not.toContain("近くの架空マンション");
  });
  it("銀行向け: 承認欄・社内メモが無い・資金計画と販売価格の根拠がある", async () => {
    const { ws, values } = await sheetOf({ ...inputs, variant: "bank" });
    expect(ws.getCell("A1").value).toBe("事業計画書(銀行向け)");
    for (const s of ["決裁者", "社内だけのメモ", "社内メモ"]) expect(values).not.toContain(s);
    expect(ws.getCell(B(ws, "自己資金")).value).toBe(5_000_000);
    expect(values).toContain("近くの架空マンション");
  });
  it("仕入・取得経費・改装・保有コスト・販売の合計は数式で、計算し直してもサーバーと一致", async () => {
    const { ws, calc } = await sheetOf();
    expectFormula(ws, B(ws, "仕入価格(税抜)"), calc.purchase.priceExcl!, /^B\d+-B\d+$/);
    expectFormula(ws, B(ws, "取得経費の合計"), calc.acquisition.total, /^SUM\(B\d+:B\d+\)$/);
    expectFormula(ws, B(ws, "改装・工事の合計"), calc.renovation.total, /^SUM\(B\d+:B\d+\)$/);
    expectFormula(ws, B(ws, "借入金利息"), calc.holding.interest, /^ROUNDDOWN\(B\d+\*ROUND\(B\d+\*10000,0\)\*B\d+\/3650000,0\)$/);
    expect(calc.holding.interest).toBe(180_493);
    expectFormula(ws, B(ws, "保有コストの合計"), calc.holding.total, /^SUM\(B\d+:B\d+\)$/);
    expectFormula(ws, B(ws, "売却価格(税抜)"), calc.sale.priceExcl!, /^B\d+-B\d+$/);
    expectFormula(ws, B(ws, "販売の費用の合計"), calc.sale.total, /^SUM\(B\d+:B\d+\)$/);
  });
  it("収支: 経費合計・粗利・利益率(TRUNC で 0.01% 切り捨て)・損益分岐は数式", async () => {
    const { ws, calc } = await sheetOf();
    expectFormula(ws, B(ws, "経費合計"), calc.profit.costTotal, /^B\d+(\+B\d+)+$/);
    expectFormula(ws, B(ws, "粗利"), calc.profit.gross!, /^B\d+-B\d+$/);
    const m = ws.getCell(B(ws, "利益率")).value;
    expect(isFormula(m) && m.formula).toMatch(/^TRUNC\(B\d+\*10000\/B\d+\)\/10000$/);
    expect(evaluate(ws, B(ws, "利益率"))).toBe(calc.profit.marginBp! / 10000);
    expect(ws.getCell(B(ws, "利益率")).numFmt).toBe("0.00%");
    expectFormula(ws, B(ws, "損益分岐の販売価格"), calc.profit.breakEven, /^B\d+$/);
  });
  it("最終レビュー: 割り切れる値でも、計算し直すと 1 つ下にならない(利益率 0.29%・利息 2,100円)", async () => {
    // 経費合計 = 仕入 19,922,000 + 印紙(仕入)10,000 + 印紙(販売)10,000 = 19,942,000・売上 20,000,000 → 粗利 58,000 = 0.29%
    // 利息 = 3,650,000 × 0.21% × 100日 ÷ 365 = 2,100(小数の掛け算だと 2,099.9999… になる)
    const d = { ...deal, price: 19_922_000, costs: DEFAULT_COSTS, settlementTerms: DEFAULT_TERMS };
    const i: BusinessInputs = {
      ...DEFAULT_BUSINESS_INPUTS, settlementPaid: 0, salePrice: 20_000_000, loanAmount: 3_650_000, loanRateBp: 21, saleDate: "2026-09-08",
    };
    const { ws, calc } = await sheetOf(i, d, resolveSectionMatrix({ unit: { holding: false } }, DEFAULT_PROPERTY_KINDS));
    expect(calc.profit.marginBp).toBe(29);
    expect(evaluate(ws, B(ws, "利益率"))).toBe(0.0029);
    const h = await sheetOf(i, d);
    expect(h.calc.holding).toMatchObject({ days: 100, interest: 2100 });
    expect(evaluate(h.ws, B(h.ws, "借入金利息"))).toBe(2100);
  });
  it("最終レビュー: 仕入・取得経費を出さなくても、経費合計と利回りは値で補ってサーバーと一致", async () => {
    const oc = { ...deal, hasOc: true, leases: [
      { room: "101", tenant: "架空 一郎", contractType: "ordinary" as const, period: null, rent: 100_000, commonFee: 5_000, parking: 0, other: 0, deposit: 200_000, arrears: false, arrearsAmount: 0, manager: null },
    ] };
    const { ws, calc } = await sheetOf(inputs, oc, resolveSectionMatrix({ unit: { purchase: false, acquisition: false } }, DEFAULT_PROPERTY_KINDS));
    expect(() => rowOf(ws, "仕入価格(税込)")).toThrow();
    expect(evaluate(ws, B(ws, "経費合計"))).toBe(calc.profit.costTotal);
    expect(evaluate(ws, B(ws, "表面利回り"))).toBe(calc.oc!.grossYieldBp! / 10000);
    expect(evaluate(ws, B(ws, "NET利回り"))).toBe(calc.oc!.netYieldBp! / 10000);
  });
  it("表で外したセクションは Excel にも無く、経費合計の数式にも入らない", async () => {
    const { ws, calc } = await sheetOf(inputs, deal, resolveSectionMatrix({ unit: { renovation: false } }, DEFAULT_PROPERTY_KINDS));
    expect(() => rowOf(ws, "改装・工事の合計")).toThrow();
    expect(() => rowOf(ws, "内装費")).toThrow();
    expectFormula(ws, B(ws, "経費合計"), calc.profit.costTotal, /^B\d+(\+B\d+)+$/);
  });
  it("売却価格・日付が無ければ、粗利・利益率・利息に数式を入れない(空欄)", async () => {
    const { ws } = await sheetOf({ ...inputs, salePrice: null, saleDate: null });
    expect(ws.getCell(B(ws, "粗利")).value).toBeNull();
    expect(ws.getCell(B(ws, "利益率")).value).toBeNull();
    expect(ws.getCell(B(ws, "借入金利息")).value).toBe(0);
  });
  it("OC収支: NOI と利回りは数式・サーバーと一致", async () => {
    const oc = { ...deal, hasOc: true, leases: [
      { room: "101", tenant: "架空 一郎", contractType: "ordinary" as const, period: null, rent: 100_000, commonFee: 5_000, parking: 0, other: 0, deposit: 200_000, arrears: false, arrearsAmount: 0, manager: null },
    ] };
    const { ws, calc } = await sheetOf(inputs, oc);
    expectFormula(ws, B(ws, "NOI"), calc.oc!.noi, /^B\d+-B\d+$/);
    expect(evaluate(ws, B(ws, "表面利回り"))).toBe(calc.oc!.grossYieldBp! / 10000);
    expect(evaluate(ws, B(ws, "NET利回り"))).toBe(calc.oc!.netYieldBp! / 10000);
  });
  it("文字は文字のまま(物件名が数式として入らない)", async () => {
    const { values, ws } = await sheetOf();
    expect(values).toContain("=HYPERLINK(\"x\")");
    let n = 0;
    ws.eachRow((row) => row.eachCell((c) => { if (isFormula(c.value) && /HYPERLINK/.test(c.value.formula)) n++; }));
    expect(n).toBe(0);
  });
});
