import { describe, it, expect } from "vitest";
import { resolveCompanyProfile, type CompanyProfile } from "../company-profile-store";
import { COMPANY_INFO } from "../company-info";

describe("resolveCompanyProfile", () => {
  it("row=null は全項目 COMPANY_INFO 既定へフォールバック", () => {
    const r = resolveCompanyProfile(null);
    expect(r.nameJa).toBe(COMPANY_INFO.nameJa);
    expect(r.tel).toBe(COMPANY_INFO.tel);
    expect(r.address).toBe(COMPANY_INFO.address);
  });
  it("DB値があれば優先", () => {
    const r = resolveCompanyProfile({ nameJa: "株式会社テスト", tel: "01-2345-6789" });
    expect(r.nameJa).toBe("株式会社テスト");
    expect(r.tel).toBe("01-2345-6789");
    expect(r.license).toBe(COMPANY_INFO.license); // 未指定はフォールバック
  });
  it("空文字/空白のみはフォールバック（保存クリアと同義）", () => {
    const r = resolveCompanyProfile({ nameJa: "", tel: "   " });
    expect(r.nameJa).toBe(COMPANY_INFO.nameJa);
    expect(r.tel).toBe(COMPANY_INFO.tel);
  });
});

// 型エクスポートの健全性確認（コンパイル時チェック用）。
const _typeCheck: CompanyProfile = {
  nameJa: "a",
  license: "b",
  tel: "c",
  fax: "d",
  email: "e",
  hp: "f",
  address: "g",
};
void _typeCheck;
