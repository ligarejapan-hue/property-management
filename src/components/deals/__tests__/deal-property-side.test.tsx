import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import DealPropertySide, { DealOwnerSideBody, DealPropertySideBody } from "../deal-property-side";
import type { OwnerSideSource } from "@/lib/deals/property-side";

describe("DealPropertySideBody", () => {
  it("読み込み中を出す", () => {
    expect(renderToStaticMarkup(<DealPropertySideBody state={{ kind: "loading" }} />)).toContain("読み込み中");
  });
  it("失敗を知らせる", () => {
    const html = renderToStaticMarkup(<DealPropertySideBody state={{ kind: "error" }} />);
    expect(html).toContain("読み込めませんでした");
    expect(html).toContain('role="alert"');
  });
  it("項目を見るだけで出す(入力欄がない)", () => {
    const html = renderToStaticMarkup(
      <DealPropertySideBody state={{ kind: "ok", property: { caseStatus: "hold", address: "東京都確認区1-2-3" } }} />,
    );
    expect(html).toContain("保留");
    expect(html).toContain("東京都確認区1-2-3");
    expect(html).not.toMatch(/<(input|select|textarea)/);
  });
});

describe("DealPropertySide", () => {
  it("閉じるボタンと、別のタブで開くリンクがある", () => {
    const html = renderToStaticMarkup(<DealPropertySide propertyId="p1" onClose={() => {}} />);
    expect(html).toContain('aria-label="物件の基本情報を閉じる"');
    expect(html).toContain('href="/properties/p1"');
    expect(html).toContain('target="_blank"');
  });
});

describe("取引の詳しい画面", () => {
  const src = readFileSync("src/app/(dashboard)/deals/[id]/page.tsx", "utf8").replace(/\r\n/g, "\n");

  it("開く権限がある人にだけ出す", () => {
    expect(src).toMatch(/canOpenProperty && deal\.propertyId/);
  });
  it("開閉でパネルを作り直さない(開いても閉じても入力が消えない)", () => {
    expect(src).not.toMatch(/sideOpen \? \(\s*<div[^]*DealBasicPanel[^]*\) : \(/);
    expect(src).toMatch(/<div className=\{sideOpen \?/);
  });
  it("連動で変わる案件ステータスを、取引の状態が変わったら読み直す", () => {
    expect(src).toMatch(/key=\{`\$\{propertyId\}:\$\{deal\.status\}`\}/);
  });
});

describe("横の所有者(当事者タブ)", () => {
  const ok = (propertyOwners: OwnerSideSource[]) => ({ kind: "ok" as const, property: { caseStatus: "hold", propertyOwners } });

  it("氏名・住所・連絡先を見るだけで出す", () => {
    const html = renderToStaticMarkup(<DealOwnerSideBody state={ok([{ owner: { id: "o1", name: "試験 太郎", zip: "100-0001", address: "東京都試験区1", currentAddress: "東京都新区2", phone: "03-0" } }])} />);
    expect(html).toContain("試験 太郎");
    expect(html).toContain("〒100-0001 東京都試験区1");
    expect(html).toContain("東京都新区2");
    expect(html).not.toMatch(/<(input|select|textarea)/);
  });
  it("★所有者を読めない人(id だけ届く)には権限がないと出す", () => {
    expect(renderToStaticMarkup(<DealOwnerSideBody state={ok([{ owner: { id: "o1" } }])} />)).toContain("見る権限がありません");
  });
  it("所有者がいないときはそう出す", () => {
    expect(renderToStaticMarkup(<DealOwnerSideBody state={ok([])} />)).toContain("登録されていません");
  });
});

describe("横の編集", () => {
  const side = readFileSync("src/components/deals/deal-property-side.tsx", "utf8").replace(/\r\n/g, "\n");
  const page = readFileSync("src/app/(dashboard)/deals/[id]/page.tsx", "utf8").replace(/\r\n/g, "\n");
  const form = readFileSync("src/components/properties/property-edit-form.tsx", "utf8").replace(/\r\n/g, "\n");

  it("★編集できる人だけ(物件を編集できる人の判定)・物件の画面と同じ編集の部品", () => {
    expect(page).toMatch(/canEdit=\{data\.canMoveCaseStatus\}/);
    expect(side).toMatch(/canEdit && !editing/);
    expect(side).toMatch(/<PropertyEditForm\s+embedded/);
  });
  it("★鍵のヘッダを送る画面なので合言葉の一生を持つ", () => {
    expect(page).toMatch(/useEditScreenToken\(\);/);
  });
  it("★横に並べるときは小窓にしない(取引の画面を隠さない)", () => {
    expect(form).toMatch(/embedded \? "" : "fixed inset-0/);
  });
  it("当事者タブでは所有者を出す", () => {
    expect(page).toMatch(/tab === "parties" \? "owners" : "property"/);
  });
});

describe("金額・費用", () => {
  const src = readFileSync("src/components/deals/deal-money-panel.tsx", "utf8").replace(/\r\n/g, "\n");
  it("★正規の料率のボタンは手で直した手数料を消して保存する", () => {
    expect(src).toContain("正規の料率で計算する");
    expect(src).toMatch(/delete nextOverrides\.brokerageFee/);
    expect(src).toMatch(/void save\(nextOverrides, bads\)/);
  });
});
