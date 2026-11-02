import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import DealPropertySide, { DealOwnerSideBody, DealPropertySideBody } from "../deal-property-side";

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

describe("編集と所有者", () => {
  it("編集の権限があっても読み込むまでは編集を出さない・権限がなければ出さない", () => {
    expect(renderToStaticMarkup(<DealPropertySide propertyId="p1" canEdit onClose={() => {}} />)).not.toContain("編集");
    const src = readFileSync("src/components/deals/deal-property-side.tsx", "utf8");
    expect(src).toMatch(/canEdit && mode === "property" && state\.kind === "ok"/);
  });
  it("当事者タブでは見出しを所有者情報にする", () => {
    const html = renderToStaticMarkup(<DealPropertySide propertyId="p1" mode="owners" onClose={() => {}} />);
    expect(html).toContain("所有者情報");
    expect(html).toContain('aria-label="所有者情報を閉じる"');
  });
  it("権限がない人・所有者がいない物件の文言", () => {
    expect(renderToStaticMarkup(<DealOwnerSideBody links={[{ owner: { id: "o" } }]} />)).toContain("権限がありません");
    expect(renderToStaticMarkup(<DealOwnerSideBody links={[]} />)).toContain("登録されていません");
  });
  it("所有者を見るだけで出す(入力欄がない)", () => {
    const html = renderToStaticMarkup(<DealOwnerSideBody links={[{ owner: { name: "甲", address: "東京都***" } }]} />);
    expect(html).toContain("東京都***");
    expect(html).not.toMatch(/<(input|select|textarea)/);
  });
  it("物件の編集の部品をそのまま使う(鍵の決まりを作り直さない)・小窓にしない", () => {
    const src = readFileSync("src/components/deals/deal-property-side.tsx", "utf8");
    expect(src).toMatch(/<PropertyEditForm\s+embedded/);
    const form = readFileSync("src/components/properties/property-edit-form.tsx", "utf8");
    expect(form).toMatch(/embedded \? "" : "fixed inset-0/);
    expect(form).toMatch(/useEditLock\(\{ resourceType: "property"/);
  });
});

describe("取引の詳しい画面", () => {
  const src = readFileSync("src/app/(dashboard)/deals/[id]/page.tsx", "utf8").replace(/\r\n/g, "\n");

  it("編集できる人の判定は、物件を書けて担当の範囲の人(canMoveCaseStatus)", () => {
    expect(src).toMatch(/canEdit=\{data\.canMoveCaseStatus\}/);
  });
  it("当事者タブでは所有者情報を横に出す・閉じたら開き直さない", () => {
    expect(src).toMatch(/tab === "parties" && !partiesSideClosed/);
    expect(src).toMatch(/mode=\{tab === "parties" \? "owners" : "property"\}/);
  });
  it("編集中は開閉のボタンを止める(鍵を持ったまま欄を消さない)", () => {
    expect(src).toMatch(/disabled=\{sideEditing\}/);
  });
  it("開く権限がある人にだけ出す", () => {
    expect(src).toMatch(/canOpenProperty && deal\.propertyId/);
  });
  it("開閉でパネルを作り直さない(開いても閉じても入力が消えない)", () => {
    expect(src).not.toMatch(/sideOpen \? \(\s*<div[^]*DealBasicPanel[^]*\) : \(/);
    expect(src).toMatch(/<div className=\{sideOpen \?/);
  });
  it("連動で変わる案件ステータスを、取引の状態が変わったら読み直す", () => {
    expect(src).toMatch(/revision=\{deal\.status\}/);
    // key に状態を入れると、編集中の入力ごと作り直してしまう。
    expect(src).toMatch(/key=\{propertyId\}/);
  });
});
