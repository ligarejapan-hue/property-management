import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PayMethodsField, payBreakdownGap, payEntriesOf, payEntriesToSend, type PayEntryValue } from "../checklist-pay-field";

const e = (method: PayEntryValue["method"], amount: number | null = null, other: string | null = null): PayEntryValue => ({ method, amount, other });
const render = (value: PayEntryValue[], total: number | null = 350_000) =>
  renderToStaticMarkup(<PayMethodsField label="残代金・精算金" total={total} value={value} onChange={() => {}} />);

describe("書類確認書の払い方(2026-11-05)", () => {
  it("現金・振込・小切手・その他のチェックボックス", () => {
    const html = render([]);
    for (const m of ["現金", "振込", "小切手", "その他"]) expect(html).toContain(`aria-label="残代金・精算金を${m}で払う"`);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).not.toContain("手付金から");
    expect(html).not.toContain("残金から");
  });
  it("その他を選んだときだけ手入力の欄", () => {
    expect(render([e("cash")])).not.toContain("その他の払い方");
    expect(render([e("other")])).toContain('aria-label="残代金・精算金のその他の払い方"');
  });
  it("1つだけなら金額の欄は出さない・2つ以上ならそれぞれに金額の欄", () => {
    expect(render([e("transfer")])).not.toContain("の金額");
    const html = render([e("cash"), e("transfer")]);
    expect(html).toContain('aria-label="残代金・精算金の現金の金額"');
    expect(html).toContain('aria-label="残代金・精算金の振込の金額"');
    expect(html).toContain("それぞれの金額を入れてください");
  });
  it("内訳の合計が金額と違えば知らせる(全部入っているときだけ)", () => {
    expect(render([e("transfer", 300_000), e("cash", 40_000)])).toContain("内訳の合計 340,000円が、金額 350,000円と違います");
    expect(render([e("transfer", 300_000), e("cash", 50_000)])).not.toContain("内訳の合計");
    expect(payBreakdownGap([e("transfer", 300_000), e("cash")], 350_000)).toBeNull();
    expect(payBreakdownGap([e("transfer", 1)], 350_000)).toBeNull();
  });
  it("値の読み取り: 形の合わないもの・前の形(文字)は捨て、選択肢の順に並べる", () => {
    expect(payEntriesOf("cash")).toEqual([]);
    expect(payEntriesOf([e("other"), { method: "card" }, e("cash", 5)])).toEqual([e("cash", 5), e("other")]);
  });
  it("送る形: 1つだけなら金額を外す・その他以外の手入力は外す・空の手入力は null", () => {
    expect(payEntriesToSend([e("cash", 5, "x")])).toEqual([e("cash")]);
    expect(payEntriesToSend([e("cash", 5), e("other", 7, "  ")])).toEqual([e("cash", 5), e("other", 7, null)]);
    expect(payEntriesToSend([e("other", null, " 預り金 ")])).toEqual([e("other", null, "預り金")]);
  });
});
