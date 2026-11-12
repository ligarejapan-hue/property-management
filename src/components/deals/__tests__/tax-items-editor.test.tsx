import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaxItemsEditor, taxItemsFromForm, taxItemsToForm, type TaxItemForm } from "../tax-items-editor";

const row = (p: Partial<TaxItemForm> = {}): TaxItemForm => ({
  kind: "land", label: "", fixedBase: "", cityBase: "", shareNum: 1, shareDen: 1, fixedTax: "", cityTax: "", ...p,
});
const render = (rows: TaxItemForm[]) => renderToStaticMarkup(<TaxItemsEditor value={rows} onChange={() => {}} />);

describe("固都税の土地・建物の行(2026-11-12)", () => {
  it("1行に課税標準額2つ・持分・税額2つ", () => {
    const html = render([row()]);
    for (const l of ["固定資産税課税標準額", "都市計画税課税標準額", "持分(分子)", "持分(分母)", "固定資産税の税額", "都市計画税の税額"]) {
      expect(html).toContain(`aria-label="土地1の${l}"`);
    }
  });
  it("税額の箱が空なら、課税標準額から出した税額を薄く見せる", () => {
    const html = render([row({ fixedBase: "1,234,567", cityBase: "1234567" })]);
    expect(html).toContain('placeholder="17,200"');
    expect(html).toContain('placeholder="3,700"');
  });
  it("土地・建物は区分ごとに番号を振り、足すボタンが2つある", () => {
    const html = render([row(), row({ kind: "building" }), row()]);
    expect(html).toContain('aria-label="土地2の固定資産税課税標準額"');
    expect(html).toContain('aria-label="建物1の固定資産税課税標準額"');
    expect(html).toContain("土地を足す");
    expect(html).toContain("建物を足す");
  });
  it("フォーム ↔ 保存の形: 空は null、読めない欄は名前を返す", () => {
    const r = taxItemsFromForm([row({ fixedBase: "1,000,000", fixedTax: "0", cityTax: "abc" })]);
    expect(r.bad).toEqual(["土地1の都市計画税の税額"]);
    const ok = taxItemsFromForm([row({ label: " 1番 ", fixedBase: "1,000,000", fixedTax: "0" })]);
    expect(ok.bad).toEqual([]);
    expect(ok.value).toEqual([{ kind: "land", label: "1番", fixedBase: 1_000_000, cityBase: null, shareNum: 1, shareDen: 1, fixedTax: 0, cityTax: null }]);
    expect(taxItemsToForm(ok.value)).toEqual([row({ label: "1番", fixedBase: "1000000", fixedTax: "0" })]);
  });
});
