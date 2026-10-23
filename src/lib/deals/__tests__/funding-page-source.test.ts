import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/deals/[id]/funding-plan/page.tsx";
const FORM = "src/components/deals/funding-plan-form.tsx";

describe("資金計画表の画面", () => {
  it("購入・売却を切り替えるボタン(押した状態を aria-pressed で示す)", () => {
    const src = read(FORM);
    expect(src).toContain('aria-label="購入・売却の切り替え"');
    expect(src).toContain("aria-pressed={form.mode === m}");
    // 切り替えは mode だけを変える(もう一方の入力・お客様名は消さない)。
    expect(src).toContain("setForm((f) => ({ ...f, mode: m }))");
  });

  it("ローンの比較は3つまで(3つあれば足すボタンを出さない)", () => {
    const src = read(FORM);
    expect(src).toContain("const MAX_LOANS = 3;");
    expect(src).toContain("form.purchase.loans.length < MAX_LOANS &&");
  });

  it("プレビューは iframe の srcDoc で、スクリプトを動かさない(sandbox を空に)", () => {
    const src = read(FORM);
    expect(src).toMatch(/<iframe[^>]*srcDoc=\{preview\.html\}[^>]*sandbox=""/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("読めない欄があれば保存しない・ほかの人の更新は 409 で知らせる", () => {
    const src = read(FORM);
    expect(src).toContain("if (!parsed.value) {");
    expect(src).toContain("保存していません");
    expect(src).toContain("VERSION_CONFLICT");
    expect(src).toContain("version: Math.max(deal.version, savedVersion), fundingPlan: parsed.value");
    expect(src).toContain("<fieldset disabled={saving !== false}");
  });

  it("「保存して発行」は保存してから発行する(発行は保存済みの入力を使う)・結果は親が持つ", () => {
    const src = read(FORM);
    const save = src.indexOf("await dealsApi.update(deal.id,");
    // 発行には、いま保存した版の番号を渡す(その間にほかの人が保存していたら 409)。
    const issue = src.indexOf('await dealsApi.issueDocument(deal.id, "funding_plan", r.version)');
    expect(save).toBeGreaterThan(0);
    expect(issue).toBeGreaterThan(save);
    // 発行の前に onSaved(作り直し)を呼ばない=発行の結果は親の notice に渡す。
    expect(src.indexOf("await onSaved();")).toBeGreaterThan(issue);
    expect(src).toContain("保存して発行(PDF・Excel)");
    const page = read(PAGE);
    expect(page).toContain("onIssue={setNotice}");
    expect(page).toContain('dealDocumentFileUrl(deal.id, notice.id, "pdf")');
  });

  it("古いプレビューの応答で新しいものを上書きしない", () => {
    const src = read(FORM);
    expect(src).toContain("if (my !== seq.current) return;");
  });

  it("保存した入力が変わったときだけ作り直す(版の番号では作り直さない)", () => {
    const src = read(PAGE);
    expect(src).toContain("key={JSON.stringify(deal.fundingPlan)}");
    expect(src).not.toContain("key={deal.version}");
  });

  it("取引の詳しい画面から資金計画表を開ける", () => {
    expect(read("src/app/(dashboard)/deals/[id]/page.tsx")).toContain("href={`/deals/${deal.id}/funding-plan`}");
  });

  it("取引の画面に「書類」タブ(発行の履歴)があり、タブを開いたときに読み直す", () => {
    const page = read("src/app/(dashboard)/deals/[id]/page.tsx");
    expect(page).toContain('{ key: "documents", label: "書類" }');
    expect(page).toContain('<DealDocumentsPanel dealId={deal.id} active={tab === "documents"} />');
    const panel = read("src/components/deals/deal-documents-panel.tsx");
    expect(panel).toContain("if (!active) return;");
    expect(panel).toContain("[dealId, active, tick]");
    // ファイルは取引の権限で配る道から開く(/uploads は使わない)。
    expect(panel).toContain('dealDocumentFileUrl(dealId, d.id, "pdf")');
    expect(panel).not.toContain("/uploads");
    expect(panel).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });
});
