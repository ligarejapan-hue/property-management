import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DealResaleSide, newSaleDealHref } from "../deal-resale-side";
import type { RelatedDeal } from "@/lib/deals/client";

const SELF_BUYER = { role: "buyer", isSelf: true };
const SELF_SELLER = { role: "seller", isSelf: true };
const deal = (parties: Array<{ role: string; isSelf: boolean }>, businessType = "resale") => ({ businessType, propertyId: "p1", parties });
const related = (over: Partial<RelatedDeal>): RelatedDeal => ({
  id: "d2", dealNo: "2026-0031", businessType: "resale", status: "considering", side: "sale", label: "", settlementAt: null, createdAt: "", price: 50_000_000, ...over,
});
const render = (d: ReturnType<typeof deal>, rel: RelatedDeal[] = [], canOpenProperty = true) =>
  renderToStaticMarkup(<DealResaleSide deal={d} relatedDeals={rel} canOpenProperty={canOpenProperty} />);
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("買取再販の仕入・売却(2026-11-05 取引を分ける)", () => {
  it("仲介の取引には何も出さない", () => {
    expect(render(deal([SELF_BUYER], "brokerage"))).toBe("");
  });
  it("仕入で売却の取引が無ければ「売却の取引を作る」(物件を開ける人だけ)", () => {
    const html = render(deal([SELF_BUYER]));
    expect(html).toContain("仕入の取引");
    expect(html).toContain("売却の取引を作る");
    expect(html).toContain(`href="${newSaleDealHref("p1").replace(/&/g, "&amp;")}"`);
    expect(newSaleDealHref("p1")).toBe("/deals/new?propertyId=p1&businessType=resale&side=sale");
    expect(render(deal([SELF_BUYER]), [], false)).not.toContain("売却の取引を作る");
  });
  it("同じ物件のもう一方の取引へのリンク・あれば作るボタンは出さない・中止は数えない", () => {
    const html = render(deal([SELF_BUYER]), [related({})]);
    expect(html).toContain("同じ物件の売却の取引");
    expect(html).toContain('href="/deals/d2"');
    expect(html).not.toContain("売却の取引を作る");
    expect(render(deal([SELF_BUYER]), [related({ status: "cancelled" })])).toContain("売却の取引を作る");
    expect(render(deal([SELF_SELLER]), [related({ side: "purchase", dealNo: "2026-0012" })])).toContain("同じ物件の仕入の取引");
  });
  it("自社が当事者にいない(前に作った取引)は、当事者タブで決める案内だけ", () => {
    const html = render(deal([]));
    expect(html).toContain("仕入か売却か決まっていません");
    expect(html).not.toContain("売却の取引を作る");
  });
});

describe("画面のつなぎ(ソース)", () => {
  it("新しい取引: 買取再販は仕入・売却を選ぶまで作れない・?side= で初めの値", () => {
    const src = read("src/app/(dashboard)/deals/new/page.tsx");
    expect(src).toContain('...(businessType === "resale" && resaleSide ? { resaleSide } : {}),');
    expect(src).toContain('(businessType === "resale" && !resaleSide)');
    expect(src).toContain('searchParams.get("side")');
  });
  it("取引の画面に1行・事業計画書は売却の取引の売買価格を入れられる", () => {
    expect(read("src/app/(dashboard)/deals/[id]/page.tsx")).toContain("<DealResaleSide deal={deal} relatedDeals={data.relatedDeals ?? []} canOpenProperty={data.canOpenProperty} />");
    expect(read("src/components/deals/business-plan-form.tsx")).toContain("の売買価格 {yenText(saleDeal.price)}円 を入れる");
    expect(read("src/app/(dashboard)/deals/[id]/business-plan/page.tsx")).toContain('d.side === "sale" && d.status !== "cancelled"');
  });
});
