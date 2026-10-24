import { describe, expect, it } from "vitest";
import { businessFormFromInputs, businessInputsFromForm } from "../business-forms";
import { DEFAULT_BUSINESS_INPUTS, type BusinessInputs } from "../business-schema";

const full: BusinessInputs = {
  ...DEFAULT_BUSINESS_INPUTS, variant: "bank", stampShare: "half", purchaseBrokerage: 726_000, settlementPaid: 0,
  acquisitionOthers: [{ label: "鍵交換", amount: 20_000 }], saleDate: "2026-11-30", loanAmount: 18_000_000, loanRateBp: 175,
  salePrice: 28_000_000, ownFunds: 5_000_000, loanMonths: 12, repayment: "amortized",
  comparables: [{ kind: "listed", name: "架空マンション", area: 58.2, price: 27_000_000, period: "2026年8月", note: null }],
  memo: "架空のメモ",
};

describe("事業計画書の入力欄 ↔ 保存の形", () => {
  it("行き来しても同じ値に戻る(0 は 0 のまま・空欄は null)", () => {
    expect(businessInputsFromForm(businessFormFromInputs(full))).toEqual({ value: full, bad: [] });
    expect(businessInputsFromForm(businessFormFromInputs(DEFAULT_BUSINESS_INPUTS))).toEqual({ value: DEFAULT_BUSINESS_INPUTS, bad: [] });
  });
  it("全角・カンマ・円は読む", () => {
    const f = businessFormFromInputs(DEFAULT_BUSINESS_INPUTS);
    const r = businessInputsFromForm({ ...f, salePrice: "２８,０００,０００円", loanRate: "１.５", loanMonths: "１２" });
    expect(r.value).toMatchObject({ salePrice: 28_000_000, loanRateBp: 150, loanMonths: 12 });
  });
  it("読めない欄は保存しない(欄の名前を返す)", () => {
    const f = businessFormFromInputs(DEFAULT_BUSINESS_INPUTS);
    const r = businessInputsFromForm({
      ...f, salePrice: "abc", loanRate: "x", loanMonths: "1.5", saleDate: "2026-02-30",
      comparables: [{ kind: "sold", name: "a", area: "広い", price: "1", period: "", note: "" }],
      acquisitionOthers: [{ label: "", amount: "5" }],
    });
    expect(r.value).toBeNull();
    expect(r.bad).toEqual(expect.arrayContaining(["売却価格", "借入金利", "借入期間", "販売価格の根拠1行目の面積", "取得経費のその他1行目の名前"]));
    expect(businessInputsFromForm({ ...f, saleDate: "2026-02-30" }).bad).toContain("販売予定日");
  });
  it("空の行(名前も金額も空)は捨てる", () => {
    const f = businessFormFromInputs(DEFAULT_BUSINESS_INPUTS);
    const r = businessInputsFromForm({
      ...f, saleOthers: [{ label: "", amount: "" }], comparables: [{ kind: "sold", name: "", area: "", price: "", period: "", note: "" }],
    });
    expect(r.value).toMatchObject({ saleOthers: [], comparables: [] });
  });
});
