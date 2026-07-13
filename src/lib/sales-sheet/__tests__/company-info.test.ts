import { describe, it, expect } from "vitest";
import { COMPANY_INFO } from "../company-info";

describe("COMPANY_INFO", () => {
  it("御社ひな型の会社情報を保持する", () => {
    expect(COMPANY_INFO.nameJa).toBe("株式会社リガーレジャパン");
    expect(COMPANY_INFO.license).toBe("宅建免許 東京都知事免許(1)第108344号");
    expect(COMPANY_INFO.tel).toBe("03-6823-2760");
    expect(COMPANY_INFO.fax).toBe("03-6823-2761");
    expect(COMPANY_INFO.email).toBe("info@ligarejapan.com");
    expect(COMPANY_INFO.hp).toBe("https://ligarejapan.com/");
    expect(COMPANY_INFO.address).toBe("154-0011 東京都世田谷区上馬4-36-15");
  });
  it("キーは7項目のみ(英字社名/保証協会/所属協会は削除)", () => {
    expect(Object.keys(COMPANY_INFO).sort()).toEqual(
      ["address", "email", "fax", "hp", "license", "nameJa", "tel"].sort(),
    );
  });
});
