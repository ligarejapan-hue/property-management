/**
 * 絞り込み枠 (UI一貫性 第2弾 ⑦) と 検索窓 (②) のSSRテスト。
 *
 * 背景: 監査ログ・添付検索・孤児DM記録などが5〜9個の操作を各自バラバラに
 * 常時展開で実装していた。物件一覧(第1弾)と同じ「よく使う+詳細条件▾
 * (N件適用中)」の形を部品化する。検索窓は「絞り込み枠の左端・最初」+
 * 幅統一(sm:w-80)が規約。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterPanel } from "../filter-panel";
import { SearchField } from "../search-field";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("FilterPanel", () => {
  it("枠の見た目は物件一覧と同じ(rounded-lg border + 白/dark)", () => {
    const html = render(<FilterPanel primary={<span>P</span>} />);
    expect(html).toContain("rounded-lg");
    expect(html).toContain("border-gray-200");
    expect(html).toContain("dark:bg-gray-900");
  });

  it("advanced が無ければトグルを出さない", () => {
    const html = render(<FilterPanel primary={<span>P</span>} />);
    expect(html).not.toContain("詳細条件");
  });

  it("詳細条件トグル: 適用数を「（N件適用中）」で表示し aria-expanded を持つ", () => {
    const html = render(
      <FilterPanel
        primary={<span>P</span>}
        advanced={<span>ADV</span>}
        advancedCount={2}
      />,
    );
    expect(html).toContain("詳細条件（2件適用中）");
    expect(html).toContain('aria-expanded="true"');
  });

  it("⚠適用中(advancedCount>0)は最初から開く(畳んだまま適用は見落としの元)", () => {
    const applied = render(
      <FilterPanel primary={<span>P</span>} advanced={<span>ADV</span>} advancedCount={1} />,
    );
    expect(applied).toContain("ADV");
    const empty = render(
      <FilterPanel primary={<span>P</span>} advanced={<span>ADV</span>} advancedCount={0} />,
    );
    expect(empty).not.toContain("ADV");
    expect(empty).toContain('aria-expanded="false"');
    expect(empty).toContain("詳細条件");
  });

  it("initialOpen で初期状態を明示指定できる(URL復元用)", () => {
    const html = render(
      <FilterPanel
        primary={<span>P</span>}
        advanced={<span>ADV</span>}
        advancedCount={0}
        initialOpen
      />,
    );
    expect(html).toContain("ADV");
  });
});

describe("SearchField", () => {
  it("虫めがねアイコン+統一幅(w-full sm:w-80)の検索窓", () => {
    const html = render(
      <SearchField value="" onChange={() => {}} placeholder="名前で検索..." />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("sm:w-80");
    expect(html).toContain('placeholder="名前で検索..."');
  });

  it("input の見た目は既存規約(rounded-md + focus indigo + dark)", () => {
    const html = render(<SearchField value="" onChange={() => {}} placeholder="p" />);
    expect(html).toContain("rounded-md");
    expect(html).toContain("focus:border-indigo-500");
    expect(html).toContain("dark:bg-gray-900");
  });

  it("width='full' で全幅にもできる(親が幅を決める画面用)", () => {
    const html = render(
      <SearchField value="" onChange={() => {}} placeholder="p" width="full" />,
    );
    expect(html).not.toContain("sm:w-80");
  });
});
