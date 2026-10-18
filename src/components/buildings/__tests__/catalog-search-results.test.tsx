import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogSearchResults } from "@/components/buildings/catalog-search-results";

const item = { id: "c1", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9, totalFloors: 14, totalUnits: 155, managementCompany: "野村不動産パートナーズ" };
describe("CatalogSearchResults", () => {
  it("見出し・中身・登録ボタン", () => {
    const html = renderToStaticMarkup(<CatalogSearchResults items={[item]} canAdopt adoptingId={null} error={null} onAdopt={() => {}} />);
    expect(html).toContain("名簿にあるマンション（1件）");
    expect(html).toContain("2026年9月竣工・14階建・155戸・管理: 野村不動産パートナーズ");
    expect(html).toContain("マンション棟に登録");
  });
  it("0件なら何も出さない・登録中はボタンを止める・失敗の文言", () => {
    expect(renderToStaticMarkup(<CatalogSearchResults items={[]} canAdopt adoptingId={null} error={null} onAdopt={() => {}} />)).toBe("");
    const html = renderToStaticMarkup(<CatalogSearchResults items={[item]} canAdopt adoptingId="c1" error="同じ名前の棟が複数あります" onAdopt={() => {}} />);
    expect(html).toContain("disabled");
    expect(html).toContain("登録しています");
    expect(html).toContain("同じ名前の棟が複数あります");
  });
  it("★書き込めない人には登録ボタンを出さない(名簿は見られる)", () => {
    const html = renderToStaticMarkup(<CatalogSearchResults items={[item]} canAdopt={false} adoptingId={null} error={null} onAdopt={() => {}} />);
    expect(html).toContain("プラウド青砥");
    expect(html).not.toContain("マンション棟に登録");
    expect(html).not.toContain("<button");
  });
});
