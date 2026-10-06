import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildingSuggestionList } from "@/components/buildings/building-name-combobox";

const a = { id: "b1", name: "パーク第一", area: "東京都大田区南雪谷1丁目", unitCount: 3, sameName: true, sameArea: true };
const b = { id: "b2", name: "パーク第一", area: "東京都大田区南雪谷2丁目", unitCount: 5, sameName: true, sameArea: false };

describe("BuildingSuggestionList", () => {
  const html = renderToStaticMarkup(
    <BuildingSuggestionList suggestions={[a, b]} activeIndex={-1} onPick={() => {}} listId="x-suggestions" />,
  );
  it("最後の行は常に「新しい棟として登録する」", () => {
    const lastLi = html.lastIndexOf("<li");
    expect(html.slice(lastLi)).toContain("新しい棟として登録する");
    expect(html.indexOf("新しい棟として登録する")).toBeGreaterThan(html.indexOf("南雪谷2丁目"));
  });
  it("丁目が違う候補に印が出る(同じ丁目には出ない)", () => {
    expect(html.match(/丁目が違います/g)?.length).toBe(1);
  });
  it("各行に 44px の高さ", () => {
    expect(html.match(/min-h-\[44px\]/g)?.length).toBe(3);
  });
  it("部屋数が出る", () => {
    expect(html).toContain("3部屋");
    expect(html).toContain("5部屋");
  });
  it("候補がなくても「新しい棟として登録する」だけは出る", () => {
    const empty = renderToStaticMarkup(
      <BuildingSuggestionList suggestions={[]} activeIndex={0} onPick={() => {}} listId="y" />,
    );
    expect(empty).toContain("新しい棟として登録する");
    expect(empty).toContain('aria-selected="true"');
  });
});
