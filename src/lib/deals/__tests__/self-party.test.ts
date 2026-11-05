import { describe, expect, it } from "vitest";
import { selfPartyFor } from "../self-party";
import { dealSideOf } from "@/lib/property-business-type";

describe("買取再販の自社の当事者(2026-11-05)", () => {
  const company = { nameJa: " 試験不動産株式会社 ", address: "東京都試験区9-9", tel: "" };
  it("仕入=買主・売却=売主に自社(法人)。空の項目は null", () => {
    expect(selfPartyFor("purchase", company)).toMatchObject({ role: "buyer", partyType: "corporation", name: "試験不動産株式会社", phone: null, isSelf: true });
    expect(selfPartyFor("sale", company).role).toBe("seller");
  });
  it("会社名が空なら「自社」", () => {
    expect(selfPartyFor("sale", { nameJa: "  ", address: "", tel: "" })).toMatchObject({ name: "自社", address: null });
  });
  it("作った取引は、今までどおり当事者から仕入・売却と読める", () => {
    expect(dealSideOf("resale", [selfPartyFor("purchase", company)])).toBe("purchase");
    expect(dealSideOf("resale", [selfPartyFor("sale", company)])).toBe("sale");
  });
});
