import { describe, expect, it } from "vitest";
import {
  PROPERTY_BUSINESS_TYPE_OPTIONS,
  businessTypeLabel,
  businessTypeMismatch,
  businessTypeWhere,
  dealSideOf,
  newDealHref,
  parseBusinessType,
  initialDealBusinessType,
  summarizePropertyDeals,
} from "../property-business-type";
import { propertyListQuerySchema, updatePropertySchema } from "../validators";

const self = (role: string) => ({ role, isSelf: true });
const other = (role: string) => ({ role, isSelf: false });

describe("取扱区分の選択肢と名前", () => {
  it("未定・仲介・買取再販の3つ(未定は空)", () => {
    expect(PROPERTY_BUSINESS_TYPE_OPTIONS).toEqual([
      { value: "", label: "(未定)" },
      { value: "brokerage", label: "仲介" },
      { value: "resale", label: "買取再販" },
    ]);
  });
  it("名前。空は未定・知らない値はそのまま", () => {
    expect(businessTypeLabel("brokerage")).toBe("仲介");
    expect(businessTypeLabel("resale")).toBe("買取再販");
    expect(businessTypeLabel(null)).toBe("未定");
    expect(businessTypeLabel("other")).toBe("other");
  });
});

describe("買取再販の取引が仕入か売却か", () => {
  it("買主が自社=仕入・売主が自社=売却", () => {
    expect(dealSideOf("resale", [self("buyer"), other("seller")])).toBe("purchase");
    expect(dealSideOf("resale", [other("buyer"), self("seller")])).toBe("sale");
  });
  it("自社がいない・仲介の取引は分からない(null)", () => {
    expect(dealSideOf("resale", [other("buyer"), other("seller")])).toBeNull();
    expect(dealSideOf("resale", [])).toBeNull();
    expect(dealSideOf("brokerage", [self("buyer")])).toBeNull();
  });
  it("自社が買主にも売主にもいる(入力の誤り)は決めない", () => {
    expect(dealSideOf("resale", [self("buyer"), self("seller")])).toBeNull();
  });
  it("仲介業者など売主・買主以外の自社は数えない", () => {
    expect(dealSideOf("resale", [self("agent"), other("seller")])).toBeNull();
  });
});

describe("物件の取引の一覧", () => {
  const deals = [
    { id: "d2", dealNo: "2026-0031", businessType: "resale", status: "considering", parties: [self("seller")] },
    { id: "d1", dealNo: "2026-0012", businessType: "resale", status: "settled", parties: [self("buyer")] },
  ];
  it("取引番号・区分・仕入/売却の名前を出す", () => {
    expect(summarizePropertyDeals(deals)).toEqual([
      { id: "d2", dealNo: "2026-0031", businessType: "resale", status: "considering", side: "sale", label: "買取再販(売却)" },
      { id: "d1", dealNo: "2026-0012", businessType: "resale", status: "settled", side: "purchase", label: "買取再販(仕入)" },
    ]);
  });
  it("仕入か売却か分からない買取再販・仲介は区分の名前だけ", () => {
    const [a, b] = summarizePropertyDeals([
      { id: "x", dealNo: "2026-0001", businessType: "resale", status: "considering", parties: [] },
      { id: "y", dealNo: "2026-0002", businessType: "brokerage", status: "considering", parties: [self("buyer")] },
    ]);
    expect(a.label).toBe("買取再販");
    expect(b.label).toBe("仲介");
  });
});

describe("物件と取引の区分の食い違い", () => {
  it("物件が未定なら食い違いなし", () => {
    expect(businessTypeMismatch(null, [{ businessType: "resale" }])).toBe(false);
  });
  it("中止の取引は数えない", () => {
    expect(businessTypeMismatch("resale", [{ businessType: "brokerage", status: "cancelled" }])).toBe(false);
  });
  it("違う区分の取引が1つでもあれば食い違い", () => {
    expect(businessTypeMismatch("resale", [{ businessType: "resale" }, { businessType: "brokerage" }])).toBe(true);
    expect(businessTypeMismatch("brokerage", [{ businessType: "brokerage" }])).toBe(false);
    expect(businessTypeMismatch("brokerage", [])).toBe(false);
  });
});

describe("物件から取引を作る画面への道", () => {
  it("取扱区分があれば渡す・未定や知らない値は渡さない", () => {
    expect(newDealHref("p1", "resale")).toBe("/deals/new?propertyId=p1&businessType=resale");
    expect(newDealHref("p1", null)).toBe("/deals/new?propertyId=p1");
    expect(newDealHref("p1", "other")).toBe("/deals/new?propertyId=p1");
  });
});

describe("一覧の絞り込みの値", () => {
  it("none は未定(空)・それ以外はそのまま", () => {
    expect(businessTypeWhere("none")).toBeNull();
    expect(businessTypeWhere("resale")).toBe("resale");
  });
});

describe("入力の検査", () => {
  it("物件の保存: 仲介・買取再販・null(未定)だけ", () => {
    expect(updatePropertySchema.parse({ version: 1, businessType: "resale" }).businessType).toBe("resale");
    expect(updatePropertySchema.parse({ version: 1, businessType: null }).businessType).toBeNull();
    expect(updatePropertySchema.safeParse({ version: 1, businessType: "other" }).success).toBe(false);
  });
  it("一覧の絞り込み: 空はすべて・none は未定", () => {
    expect(propertyListQuerySchema.parse({ businessType: "" }).businessType).toBeUndefined();
    expect(propertyListQuerySchema.parse({ businessType: "none" }).businessType).toBe("none");
    expect(propertyListQuerySchema.safeParse({ businessType: "other" }).success).toBe(false);
  });
});

describe("外から来た値を読む", () => {
  it("知っている値だけ・ほかは null", () => {
    expect(parseBusinessType("resale")).toBe("resale");
    expect(parseBusinessType("xyz")).toBeNull();
    expect(parseBusinessType(null)).toBeNull();
  });
});

describe("新しい取引の事業区分の初期値", () => {
  it("物件の取扱区分があればそれ・未定や知らない値なら仲介", () => {
    expect(initialDealBusinessType("resale")).toBe("resale");
    expect(initialDealBusinessType("brokerage")).toBe("brokerage");
    expect(initialDealBusinessType(null)).toBe("brokerage");
    expect(initialDealBusinessType("")).toBe("brokerage");
    expect(initialDealBusinessType("other")).toBe("brokerage");
  });
});
