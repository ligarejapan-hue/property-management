import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CrosscheckPanel } from "../deal-crosscheck";
import { CROSSCHECK_NOTICE_IDS, buildCrosscheck, type CrosscheckInput } from "@/lib/deals/crosscheck";

const input = (over: Partial<CrosscheckInput> = {}): CrosscheckInput => ({
  kindBase: "unit", price: 30_000_000, settlementDate: "2026-11-30",
  snapshot: { floorArea: 65.5, landArea: null },
  property: { exclusiveArea: "65.50", exclusiveAreaRegistry: null, landArea: null, landAreaMethod: null, totalFloorArea: null },
  registry: { status: "none" }, sellerCompare: "allowed", sellers: [], documents: [], ...over,
});
const render = (i: CrosscheckInput, canOpenProperty = true) => renderToStaticMarkup(
  <CrosscheckPanel result={buildCrosscheck(i)} dealId="d" propertyId="p" canOpenProperty={canOpenProperty} onOpenTab={() => {}} />,
);
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("照合の表示", () => {
  it("一致があっても片方が未入力が残れば照合OKと出さず、確認できていない項目がありますと未確認の件数を出す(開いて出す・2026-11-04)", () => {
    const html = render(input());
    expect(html).not.toContain("照合OK");
    expect(html).toContain("確認できていない項目があります");
    expect(html).toContain("未確認");
    expect(html).toContain("<details open");
  });
  it("不一致=N件の食い違い(開いて出す)・出どころと値", () => {
    const html = render(input({ snapshot: { floorArea: 70, landArea: null } }));
    expect(html).toContain("1件の食い違い");
    expect(html).toContain("<details open");
    expect(html).toContain("70.00㎡");
    expect(html).toContain("65.50㎡");
  });
  it("比べられた項目が無い=照合できる項目がありません", () => {
    const html = render(input({ kindBase: null, property: null }));
    expect(html).toContain("照合できる項目がありません");
    expect(html).not.toContain("照合OK");
  });
  it("土地か建物の謄本が足りない=照合OKと出さず、開いて出す", () => {
    const html = render(input({
      kindBase: "house", snapshot: { floorArea: 91, landArea: 120 },
      documents: [{ documentId: "doc-1", docType: "funding_plan", variant: "purchase", version: 1, title: "資金計画表(購入)", issuedAt: "2026-10-01T00:00:00.000Z", price: 30_000_000 }],
      property: { exclusiveArea: null, exclusiveAreaRegistry: null, landArea: "120", landAreaMethod: null, totalFloorArea: "91" },
      registry: {
        status: "ok", missing: ["建物"], uncertain: null, areas: null, owners: null,
        rights: { activeRights: 1, readable: true, attachmentCreatedAt: "2026-10-05T03:00:00.000Z" },
        certificates: [{ side: "土地", createdAt: "2026-10-05T03:00:00.000Z" }],
      },
    }));
    expect(html).toContain("確認できていない項目があります");
    expect(html).not.toContain("照合OK");
    expect(html).toContain("<details open");
    expect(html).toContain("確認できない(建物の謄本がありません)");
    expect(html).toContain("照合に使った謄本: 2026/10/05 取込(土地)");
    expect(html).toContain("読めた謄本では 1件");
  });
  it("異体字=表記の違いの結果と注意を、開いて出す", () => {
    const html = render(input({
      sellers: [{ name: "高橋一郎", shareNum: null, shareDen: null }],
      registry: { status: "ok", areas: null, rights: null, owners: { list: [{ name: "髙橋一郎", share: null }], confirmed: true, attachmentCreatedAt: "2026-10-05T03:00:00.000Z" } },
    }));
    expect(html).toContain("表記の違い(異体字)");
    expect(html).toContain(`data-notice-id="${CROSSCHECK_NOTICE_IDS.nameVariant}"`);
    expect(html).toContain("<details open");
    expect(html).not.toContain("髙橋");
  });
  it("リンク: 書類は PDF・物件は見られる人だけ", () => {
    const docs = [{ documentId: "doc-9", docType: "funding_plan", variant: "purchase", version: 1, title: "資金計画表(購入)", issuedAt: "2026-10-01T00:00:00.000Z", price: 30_000_000 }];
    const html = render(input({ documents: docs }));
    expect(html).toContain("/api/deals/d/documents/doc-9/file?format=pdf");
    expect(html).toContain('href="/properties/p"');
    expect(render(input(), false)).not.toContain('href="/properties/p"');
  });
  it("謄本の日付と注意(識別子つき)を出す", () => {
    const html = render(input({
      registry: { status: "ok", areas: null, owners: null, rights: { activeRights: 1, readable: true, attachmentCreatedAt: "2026-01-05T03:00:00.000Z" } },
    }));
    expect(html).toContain("照合に使った謄本: 2026/01/05 取込(担保)");
    expect(html).toContain(`data-notice-id="${CROSSCHECK_NOTICE_IDS.activeMortgage}"`);
    expect(html).toContain("抹消書類の手配を確認してください");
    expect(html).toContain(`data-notice-id="${CROSSCHECK_NOTICE_IDS.registryStale}"`);
    expect(html).toContain("謄本が古い可能性があります");
  });
});

describe("画面のつなぎ", () => {
  it("取引の画面のタブの上に出し、保存・発行で読み直す", () => {
    const src = read("src/app/(dashboard)/deals/[id]/page.tsx");
    expect(src.indexOf("<DealCrosscheck")).toBeGreaterThan(-1);
    expect(src.indexOf("<DealCrosscheck")).toBeLessThan(src.indexOf("<Tabs "));
    expect(src).toContain("revision={k([deal.version, deal.parties, issuedTick])}");
    expect(src).toContain("onIssued={() => setIssuedTick((t) => t + 1)}");
  });
  it("発行の入口3か所すべてで確認を挟む(発行は止めない)", () => {
    for (const [p, type] of [
      ["src/components/deals/business-docs-section.tsx", "doc.docType"],
      ["src/components/deals/funding-plan-form.tsx", '"funding_plan"'],
      ["src/components/deals/business-plan-form.tsx", '"business_plan"'],
    ]) {
      const src = read(p);
      expect(src).toContain(`useIssueCrosscheck(`);
      expect(src).toContain(type);
      expect(src).toContain("crosscheck.guard(");
      expect(src).toContain("{crosscheck.dialog}");
    }
    const hook = read("src/components/deals/use-issue-crosscheck.tsx");
    expect(hook).toContain("このまま発行する");
    // 照合を読めなくても発行へ進む。
    expect(hook).toMatch(/catch \{\s*found = \[\];\s*\}/);
  });
});
