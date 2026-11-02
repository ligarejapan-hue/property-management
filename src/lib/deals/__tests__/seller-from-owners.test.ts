import { describe, expect, it } from "vitest";
import { ownersExceptCompany, sellerAccessOf, sellerPartiesFromOwners } from "../seller-from-owners";

const owner = (over: Record<string, unknown> = {}) => ({
  name: "試験 太郎", phone: "03-0000-0000", address: "東京都試験区1-2-3", currentAddress: null,
  corporateNumber: null, companyRegistryNumber: null, ...over,
});
const ALL = { name: true, address: true, phone: true };

describe("物件の所有者を売主にする", () => {
  it("★氏名・住所・電話を入れる", () => {
    expect(sellerPartiesFromOwners([owner()], [], ALL)).toEqual([
      { role: "seller", partyType: "individual", name: "試験 太郎", address: "東京都試験区1-2-3", phone: "03-0000-0000", isSelf: false },
    ]);
  });

  it("★現住所があれば現住所を入れる", () => {
    expect(sellerPartiesFromOwners([owner({ currentAddress: "東京都新区9-9" })], [], ALL)[0].address).toBe("東京都新区9-9");
    expect(sellerPartiesFromOwners([owner({ currentAddress: "  " })], [], ALL)[0].address).toBe("東京都試験区1-2-3");
  });

  it("★すでに売主にいる人は足さない(表記の違いは同じ人とみなす)・共有なら全員", () => {
    const owners = [owner({ name: "試験　太郎" }), owner({ name: "試験 花子" })];
    expect(sellerPartiesFromOwners(owners, ["試験 太郎"], ALL).map((p) => p.name)).toEqual(["試験 花子"]);
    expect(sellerPartiesFromOwners([owner(), owner()], [], ALL)).toHaveLength(1);
  });

  it("★見られない項目は入れない・氏名が見られなければ誰も入れない", () => {
    const p = sellerPartiesFromOwners([owner()], [], { name: true, address: false, phone: false })[0];
    expect(p.address).toBeNull();
    expect(p.phone).toBeNull();
    expect(sellerPartiesFromOwners([owner()], [], { name: false, address: true, phone: true })).toEqual([]);
  });

  it("法人を見分ける", () => {
    const type = (o: Record<string, unknown>) => sellerPartiesFromOwners([owner(o)], [], ALL)[0].partyType;
    expect(type({ name: "試験不動産株式会社" })).toBe("corporation");
    expect(type({ name: "（株）試験" })).toBe("corporation");
    expect(type({ name: "試験", corporateNumber: "1234567890123" })).toBe("corporation");
    expect(type({ name: "株田 太郎" })).toBe("individual");
  });

  it("★欄に入らない長さは保存で落ちないように扱う", () => {
    const long = sellerPartiesFromOwners([owner({ address: "あ".repeat(301), phone: "1".repeat(51) })], [], ALL)[0];
    expect(long.address).toBeNull();
    expect(long.phone).toBeNull();
    expect(sellerPartiesFromOwners([owner({ name: "あ".repeat(201) })], [], ALL)).toEqual([]);
    expect(sellerPartiesFromOwners([owner({ name: "  " })], [], ALL)).toEqual([]);
  });
});

describe("売主に入れてよい範囲(依頼文の差し込みと同じ決まり)", () => {
  it("所有者を読めない人は何も入れない", () => {
    expect(sellerAccessOf([])).toEqual({ name: false, address: false, phone: false });
  });
});

describe("自社の名前の所有者", () => {
  it("空白や(株)の書き方が違っても除く", () => {
    const owners = [owner({ name: "リガーレ 株式会社" }), owner({ name: "(株)リガーレ" }), owner()];
    expect(ownersExceptCompany(owners, "株式会社リガーレ").map((o) => o.name)).toEqual(["リガーレ 株式会社", "試験 太郎"]);
    expect(ownersExceptCompany(owners, "リガーレ株式会社").map((o) => o.name)).toEqual(["(株)リガーレ", "試験 太郎"]);
  });
});
