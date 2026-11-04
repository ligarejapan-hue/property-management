import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DealPropertySaleTax, saleTaxRows } from "../deal-property-sale-tax";

// 2026-11-04 発注者: 物件の編集にある消費税(課税・不課税)を、金額・費用タブでも見る・編集できるように。
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("物件の販売価格と消費税(金額・費用タブ)", () => {
  it("万円で保存した値を円で出す・未設定はそう出す", () => {
    expect(saleTaxRows({ salePrice: 3280, saleTaxType: "税込", saleTaxAmount: 120 })).toEqual([
      { label: "販売価格", value: "3,280万円" },
      { label: "消費税", value: "税込" },
      { label: "うち消費税", value: "120万円" },
    ]);
    expect(saleTaxRows({})).toEqual([
      { label: "販売価格", value: "—" },
      { label: "消費税", value: "(未設定)" },
      { label: "うち消費税", value: "—" },
    ]);
  });
  it("編集できる人にだけ「編集」を出す", () => {
    const noop = () => {};
    expect(renderToStaticMarkup(<DealPropertySaleTax propertyId="p" revision="r" canEdit onEdit={noop} />)).toContain("編集");
    expect(renderToStaticMarkup(<DealPropertySaleTax propertyId="p" revision="r" canEdit={false} onEdit={noop} />)).not.toContain("<button");
  });
  it("取引の画面: 物件を開ける人だけ出し、編集は横に物件の編集を開いて消費税の欄へ", () => {
    const page = read("src/app/(dashboard)/deals/[id]/page.tsx");
    expect(page).toContain("property={propertyId ? { id: propertyId, revision: String(sideEditing), canEdit: data.canMoveCaseStatus, onEdit: editSaleTax } : null}");
    expect(page).toContain("const editSaleTax = () => { openSide(); setSideEditing(true); setSideEditRequest((n) => n + 1); };");
    expect(page).toContain('focusField="saleTaxType"');
    expect(page).toContain("editRequest={sideEditRequest}");
    // 閉じたら合図を戻す=次に開いたときに勝手に編集を開かない。
    expect(page).toMatch(/const closeSide = \(\) => \{[^}]*setSideEditRequest\(0\)/);
  });
  it("横の欄: 合図が増えたら(読み込み後に)編集を開く・編集の部品は欄まで送る", () => {
    const side = read("src/components/deals/deal-property-side.tsx");
    expect(side).toContain("if (editRequest !== seenRequest) {");
    expect(side).toContain('if (pendingEdit && !editing && state.kind === "ok") {');
    expect(side).toContain("focusField={focusField}");
    const form = read("src/components/properties/property-edit-form.tsx");
    expect(form).toContain("data-field-key={field.key}");
    expect(form).toContain("document.querySelector(`[data-field-key=\"${focusField}\"]`)");
  });
  it("特例のチェックは仲介手数料の欄のいちばん下", () => {
    const panel = read("src/components/deals/deal-money-panel.tsx");
    const special = panel.indexOf("低廉な空家等の特例(800万円以下");
    expect(special).toBeGreaterThan(panel.indexOf("正規の手数料率で計算する"));
    expect(special).toBeGreaterThan(panel.indexOf("まだ保存していません"));
    expect(special).toBeLessThan(panel.indexOf("売買契約書の印紙税"));
  });
});
