import { describe, expect, it } from "vitest";
import { fundingFormFromInputs, fundingInputsFromForm } from "../funding-forms";
import { DEFAULT_FUNDING_INPUTS, type FundingInputs } from "../funding-schema";

const filled: FundingInputs = {
  mode: "sale",
  customerName: "架空 太郎",
  stampShare: "half",
  purchase: {
    ...DEFAULT_FUNDING_INPUTS.purchase, scrivenerFee: 100_000, loanFeeType: "rate", loanFeeRateBp: 220, ownFunds: 5_000_000,
    others: [{ label: "引越し費用", amount: 100_000 }], loans: [{ annualRateBp: 100, years: 35 }, { annualRateBp: 85, years: 30 }],
  },
  sale: { ...DEFAULT_FUNDING_INPUTS.sale, loanBalance: 10_000_000, acquiredOn: "2015-03-01", residentialDeduction: true },
};

describe("資金計画表の画面の形", () => {
  it("保存した形 → 画面 → 保存する形 で元に戻る(購入・売却の両方を持つ)", () => {
    const form = fundingFormFromInputs(filled);
    expect(form.purchase.loanFeeRate).toBe("2.2");
    expect(form.purchase.loans[1]).toEqual({ rate: "0.85", years: "30" });
    expect(fundingInputsFromForm(form)).toEqual({ value: filled, bad: [] });
  });

  it("購入・売却を切り替えても、もう一方の入力は残る", () => {
    const form = { ...fundingFormFromInputs(filled), mode: "purchase" as const };
    expect(fundingInputsFromForm(form).value?.sale.loanBalance).toBe(10_000_000);
    expect(fundingInputsFromForm(form).value?.purchase.scrivenerFee).toBe(100_000);
  });

  it("読めない金額・金利・年数は欄の名前を並べ、保存する形を作らない(0 や空にしない)", () => {
    const form = fundingFormFromInputs(filled);
    form.purchase.scrivenerFee = "10万";
    form.sale.loanBalance = "-1";
    form.purchase.loans[0] = { rate: "一%", years: "35年" };
    const r = fundingInputsFromForm(form);
    expect(r.value).toBeNull();
    expect(r.bad).toEqual(expect.arrayContaining(["司法書士報酬", "ローン残債", "パターン1の金利", "パターン1の年数"]));
  });

  it("全角の数字・カンマ付きは読む・空は空(null)", () => {
    const form = fundingFormFromInputs(DEFAULT_FUNDING_INPUTS);
    form.purchase.loanAmount = "４０，０００，０００";
    form.purchase.loans[0] = { rate: "１.０", years: "３５" };
    const v = fundingInputsFromForm(form).value;
    expect(v?.purchase.loanAmount).toBe(40_000_000);
    expect(v?.purchase.loans[0]).toEqual({ annualRateBp: 100, years: 35 });
    expect(v?.purchase.ownFunds).toBeNull();
  });

  it("範囲の外(金利30%超・年数51年・ありえない日付)は場所を平易に出す", () => {
    const form = fundingFormFromInputs(filled);
    form.purchase.loans[0] = { rate: "31", years: "51" };
    form.sale.acquiredOn = "2015-02-30";
    const r = fundingInputsFromForm(form);
    expect(r.value).toBeNull();
    expect(r.bad).toEqual(expect.arrayContaining(["パターン1の金利(0〜30%)", "パターン1の年数(1〜50年)", "取得日"]));
  });

  it("名前も金額も空のその他の行は捨てる・名前があって金額が読めない行は知らせる", () => {
    const form = fundingFormFromInputs(filled);
    form.purchase.others = [{ label: " ", amount: "" }, { label: "家具", amount: "abc" }];
    expect(fundingInputsFromForm(form).bad).toEqual(["購入のその他の費用2行目の金額"]);
    form.purchase.others = [{ label: " ", amount: " " }, { label: "家具", amount: "300000" }];
    expect(fundingInputsFromForm(form).value?.purchase.others).toEqual([{ label: "家具", amount: 300_000 }]);
  });
});

describe("最終レビュー: その他の行・大きすぎる金額", () => {
  it("名前が空で金額だけある行は捨てずに知らせる(合計から黙って落とさない)", () => {
    const form = fundingFormFromInputs(filled);
    form.purchase.others = [{ label: "", amount: "50000" }];
    const r = fundingInputsFromForm(form);
    expect(r.value).toBeNull();
    expect(r.bad).toEqual(["購入のその他の費用1行目の名前"]);
  });
  it("行の番号は画面の並びのまま(空の行を数えて飛ばさない)", () => {
    const form = fundingFormFromInputs(filled);
    form.sale.others = [{ label: "", amount: "" }, { label: "残置物", amount: "abc" }];
    expect(fundingInputsFromForm(form).bad).toEqual(["売却のその他の費用2行目の金額"]);
  });
  it("1兆円を超える金額は欄の名前で知らせる", () => {
    const form = fundingFormFromInputs(filled);
    form.purchase.loanAmount = "2000000000000";
    expect(fundingInputsFromForm(form).bad).toEqual(["借入額(1兆円まで)"]);
  });
});
