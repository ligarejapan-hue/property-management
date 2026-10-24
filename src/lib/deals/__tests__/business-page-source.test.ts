import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/deals/[id]/business-plan/page.tsx";
const FORM = "src/components/deals/business-plan-form.tsx";
const DETAIL = "src/app/(dashboard)/deals/[id]/page.tsx";

describe("事業計画書の画面", () => {
  it("取引の画面のボタンは買取再販の取引だけ", () => {
    expect(read(DETAIL)).toMatch(/deal\.businessType === "resale" && \(\s*<Link href=\{`\/deals\/\$\{deal\.id\}\/business-plan`\}/);
  });
  it("買取再販でなければ入力欄を出さない・保存した入力が変わったときだけ作り直す", () => {
    const src = read(PAGE);
    expect(src).toContain('deal.businessType !== "resale"');
    expect(src).toContain("key={JSON.stringify(deal.businessPlan)}");
  });
  it("社内用/銀行向けの切り替え・保存は businessPlan だけを送る・プレビューは何も許さない iframe", () => {
    const src = read(FORM);
    expect(src).toContain('aria-label="社内用・銀行向けの切り替え"');
    expect(src).toMatch(/dealsApi\.update\(deal\.id, \{ version: Math\.max\(deal\.version, savedVersion\), businessPlan: parsed\.value \}\)/);
    expect(src).toMatch(/<iframe[^>]*srcDoc=\{preview\.html\}[^>]*sandbox=""/);
    expect(src).toContain("<fieldset disabled={saving}");
  });
  it("仲介手数料は自動で入れず、上限額を入れるボタンだけ", () => {
    const src = read(FORM);
    expect(src).toContain("calc?.brokerageCap.purchase");
    expect(src).toContain("calc?.brokerageCap.sale");
    expect(src).toContain("を入れる");
  });
  it("最終レビュー: 出さないセクションの入力欄は出さない(プレビューと同じ決まり)", () => {
    const src = read(FORM);
    for (const s of ["acquisition", "renovation", "financing", "oc", "evidence"]) {
      expect(src, s).toContain(`{shown("${s}") && (`);
    }
  });
  it("@codex: ほかの出すセクションが使う欄は残す(売却価格=収支・借入額=資金計画)", () => {
    const src = read(FORM);
    expect(src).toContain('{(shown("sale") || shown("profit")) && (');
    expect(src).toContain('{(shown("holding") || shown("financing")) && (');
    // 外したセクションだけの費用の欄は、そのセクションを出すときだけ
    expect(src).toMatch(/\{shown\("sale"\) && \(\s*<>\s*\{yen\("saleBuildingTax"/);
    expect(src).toMatch(/\{shown\("holding"\) && \(\s*<>\s*<Field label="販売予定日"/);
  });
  it("管理者だけの設定画面へのリンクは置かない(開けない人がいる)", () => {
    expect(read(FORM)).not.toContain('href="/admin/deal-settings"');
  });
});
