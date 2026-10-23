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
    expect(src).toContain("version: deal.version, fundingPlan: parsed.value");
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
});
