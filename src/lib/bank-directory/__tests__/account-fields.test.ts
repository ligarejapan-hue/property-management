import { describe, expect, it } from "vitest";
import { pickBank, pickBranch, typeBank, typeBranch } from "../account-fields";

const chosen = { bankName: "みずほ銀行", bankCode: "0001", branchName: "神田支店", branchCode: "108", accountNumber: "1234567" };

describe("銀行名・支店名の入力の移り変わり", () => {
  it("銀行を候補から選ぶと、名前とコードが入る", () => {
    const v = { bankName: "み", bankCode: "", branchName: "", branchCode: "", accountNumber: "" };
    expect(pickBank(v, { code: "0001", name: "みずほ銀行" })).toEqual({ ...v, bankName: "みずほ銀行", bankCode: "0001" });
  });
  it("別の銀行を選び直すと、前の銀行の支店は消す(ほかの欄は残す)", () => {
    expect(pickBank(chosen, { code: "0005", name: "三菱UFJ銀行" })).toEqual({
      ...chosen, bankName: "三菱UFJ銀行", bankCode: "0005", branchName: "", branchCode: "",
    });
  });
  it("同じ銀行を選び直しても、支店は残す", () => {
    expect(pickBank({ ...chosen, bankName: "みず" }, { code: "0001", name: "みずほ銀行" })).toEqual(chosen);
  });
  it("コードの無い銀行名(打ち込んだ・前に入れた口座)から選んだときは、打ち込んだ支店名を残す", () => {
    const v = { bankName: "みずほ", bankCode: "", branchName: "神田支店", branchCode: "", accountNumber: "" };
    expect(pickBank(v, { code: "0001", name: "みずほ銀行" })).toEqual({ ...v, bankName: "みずほ銀行", bankCode: "0001" });
  });
  it("銀行名を打ち直すと、銀行と支店のコードを外す(支店名の文字は残す)", () => {
    expect(typeBank(chosen, "みずほ銀行 ")).toEqual({ ...chosen, bankName: "みずほ銀行 ", bankCode: "", branchCode: "" });
  });
  it("支店を候補から選ぶと、名前とコードが入る/打ち直すとコードを外す", () => {
    const v = { ...chosen, branchName: "か", branchCode: "" };
    expect(pickBranch(v, { code: "108", name: "神田支店" })).toEqual(chosen);
    expect(typeBranch(chosen, "神田")).toEqual({ ...chosen, branchName: "神田", branchCode: "" });
  });
});
