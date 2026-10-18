import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildingSuggestionList } from "@/components/buildings/building-name-combobox";

const cat = { catalogId: "c1", name: "プラウド青砥", area: "東京都葛飾区青戸4丁目", builtYear: 2026, totalFloors: 14, totalUnits: 155, sameName: true, sameArea: false };
describe("候補の一覧の名簿の段", () => {
  it("見出し・行の中身・丁目の札を出し、新しい棟は一番下", () => {
    const html = renderToStaticMarkup(
      <BuildingSuggestionList suggestions={[]} catalog={[cat]} activeIndex={-1} onPick={() => {}} listId="x" />,
    );
    expect(html).toContain("名簿にあるマンション");
    expect(html).toContain("2026年竣工・14階建・155戸");
    expect(html).toContain("丁目が違います");
    expect(html.indexOf("プラウド青砥")).toBeLessThan(html.indexOf("新しい棟として登録する"));
    expect(html).toContain('id="x-opt-0"');
  });
});
