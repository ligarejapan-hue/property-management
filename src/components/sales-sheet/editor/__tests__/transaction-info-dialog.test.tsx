import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TransactionInfoDialog } from "../TransactionInfoDialog";

const initial = {
  transactionType: "専任",
  adType: "不可",
  compensation: "税込3%",
  staff: "山田",
  agent: "佐藤",
  specialNotes: "即入居可",
};

describe("TransactionInfoDialog", () => {
  it("open=false では何も描画しない", () => {
    const html = renderToStaticMarkup(
      <TransactionInfoDialog open={false} initial={initial} onApply={() => {}} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("open=true で6項目のラベルと現在値を描画する", () => {
    const html = renderToStaticMarkup(
      <TransactionInfoDialog open initial={initial} onApply={() => {}} onClose={() => {}} />,
    );
    for (const label of ["取引態様", "広告", "報酬", "担当者", "取引士", "特記事項"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("山田");
    expect(html).toContain("佐藤");
    // combo(datalist)の候補と select の選択肢が出る
    expect(html).toContain("専属専任");
    expect(html).toContain("税込3%+6万円");
  });
});
