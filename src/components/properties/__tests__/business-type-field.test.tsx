import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BusinessTypeField from "../business-type-field";
import type { PropertyDealSummary } from "@/lib/property-business-type";

const deal = (o: Partial<PropertyDealSummary>): PropertyDealSummary => ({
  id: "d1", dealNo: "2026-0012", businessType: "resale", status: "considering", side: "purchase", label: "買取再販(仕入)",
  settlementAt: null, createdAt: "2026-03-01T00:00:00.000Z", ...o,
});
const draw = (businessType: string | null, deals: PropertyDealSummary[] | null) =>
  renderToStaticMarkup(<BusinessTypeField businessType={businessType} deals={deals} />);

describe("基本情報の取扱区分", () => {
  it("区分の名前・未定", () => {
    expect(draw("resale", [])).toContain("買取再販");
    expect(draw(null, [])).toContain("未定");
  });
  it("取引を番号のリンク・仕入/売却・状態で並べる", () => {
    const html = draw("resale", [deal({}), deal({ id: "d2", dealNo: "2026-0031", side: "sale", label: "買取再販(売却)", status: "contracted" })]);
    expect(html).toContain('href="/deals/d1"');
    expect(html).toContain("買取再販(仕入)");
    expect(html).toContain('href="/deals/d2"');
    expect(html).toContain("買取再販(売却)");
    expect(html).toContain("契約済");
  });
  it("取引を見る権限が無い(null)なら取引の行を出さない", () => {
    expect(draw("resale", null)).not.toContain("/deals/");
  });
  it("違う区分の取引があれば知らせる・同じなら出さない", () => {
    expect(draw("resale", [deal({ businessType: "brokerage", label: "仲介", side: null })])).toContain("違う区分の取引があります");
    expect(draw("resale", [deal({})])).not.toContain("違う区分の取引があります");
    expect(draw(null, [deal({ businessType: "brokerage" })])).not.toContain("違う区分の取引があります");
  });
});
