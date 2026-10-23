import { describe, expect, it } from "vitest";
import { DEFAULT_FUNDING_INPUTS, fundingInputsSchema, readFundingInputs } from "../funding-schema";

describe("資金計画表の入力", () => {
  it("空・壊れた JSON は初期値で読む", () => {
    expect(readFundingInputs({})).toEqual(DEFAULT_FUNDING_INPUTS);
    expect(readFundingInputs(null)).toEqual(DEFAULT_FUNDING_INPUTS);
    expect(readFundingInputs({ funding: "x" })).toEqual(DEFAULT_FUNDING_INPUTS);
    expect(readFundingInputs({ funding: { mode: "other" } })).toEqual(DEFAULT_FUNDING_INPUTS);
  });

  it("足りない項目は初期値で補う(購入・売却の中も)", () => {
    const r = readFundingInputs({ funding: { mode: "sale", purchase: { ownFunds: 5_000_000 }, sale: { loanBalance: 1000 } } });
    expect(r.mode).toBe("sale");
    expect(r.purchase.ownFunds).toBe(5_000_000);
    expect(r.purchase.loanFeeType).toBe("fixed");
    expect(r.sale.loanBalance).toBe(1000);
    expect(r.sale.residentialDeduction).toBe(false);
  });

  it("ほかの鍵(事業計画書)があっても資金計画表だけを読む", () => {
    expect(readFundingInputs({ business: { a: 1 }, funding: { customerName: "架空 太郎" } }).customerName).toBe("架空 太郎");
  });

  it("ローンの比較は3つまで・金利 0〜30%・年数 1〜50", () => {
    const loans = (xs: { annualRateBp: number; years: number }[]) =>
      fundingInputsSchema.safeParse({ ...DEFAULT_FUNDING_INPUTS, purchase: { ...DEFAULT_FUNDING_INPUTS.purchase, loans: xs } }).success;
    expect(loans([{ annualRateBp: 100, years: 35 }, { annualRateBp: 0, years: 1 }, { annualRateBp: 3000, years: 50 }])).toBe(true);
    expect(loans(Array(4).fill({ annualRateBp: 100, years: 35 }))).toBe(false);
    expect(loans([{ annualRateBp: 3001, years: 35 }])).toBe(false);
    expect(loans([{ annualRateBp: 100, years: 0 }])).toBe(false);
    expect(loans([{ annualRateBp: 100, years: 51 }])).toBe(false);
  });

  it("取得日は YYYY-MM-DD だけ・お客様名は前後の空白を落とす", () => {
    const sale = (acquiredOn: string | null) =>
      fundingInputsSchema.safeParse({ ...DEFAULT_FUNDING_INPUTS, sale: { ...DEFAULT_FUNDING_INPUTS.sale, acquiredOn } }).success;
    expect(sale("2015-03-01")).toBe(true);
    expect(sale("2015/03/01")).toBe(false);
    expect(sale("2015-02-30")).toBe(false);
    expect(fundingInputsSchema.parse({ ...DEFAULT_FUNDING_INPUTS, customerName: "  架空 花子 " }).customerName).toBe("架空 花子");
  });

  it("知らない項目は受け付けない", () => {
    expect(fundingInputsSchema.safeParse({ ...DEFAULT_FUNDING_INPUTS, extra: 1 }).success).toBe(false);
  });
});
