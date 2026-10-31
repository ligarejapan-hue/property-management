import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import DealPropertySide, { DealPropertySideBody } from "../deal-property-side";

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
