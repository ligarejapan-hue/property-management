import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RegistryEntriesPanel,
  RegistryShareBadge,
} from "@/components/properties/registry-entries-panel";

/**
 * 登記上の記載(所有者事項の行ごとの住所と持分・2026-11-12 発注者決定)の見た目。
 * - 持分の札は所有者全員に出す(共有者も・行が1つだけの人も)。
 * - 内訳の表は行が2つ以上の人だけ。
 */
const three = {
  entries: [
    { position: 1, address: "東京都港区見本1-1-1", share: { num: 2, den: 10 } },
    { position: 2, address: "埼玉県さいたま市見本区2-2-2", share: { num: 3, den: 10 } },
    { position: 3, address: "神奈川県横浜市見本区3-3-3", share: { num: 2, den: 10 } },
  ],
  shareTotal: { num: 7, den: 10 },
};
const one = {
  entries: [{ position: 2, address: "神奈川県横浜市見本区3-3-3", share: { num: 3, den: 10 } }],
  shareTotal: { num: 3, den: 10 },
};

describe("RegistryShareBadge", () => {
  it("持分の合計を札で出す(行が1つだけの共有者にも出す)", () => {
    expect(renderToStaticMarkup(<RegistryShareBadge registry={three} />)).toContain("持分 7/10");
    expect(renderToStaticMarkup(<RegistryShareBadge registry={one} />)).toContain("持分 3/10");
  });

  it("合計が出せない・記載が無いときは何も出さない", () => {
    expect(renderToStaticMarkup(<RegistryShareBadge registry={{ ...one, shareTotal: null }} />)).toBe("");
    expect(renderToStaticMarkup(<RegistryShareBadge registry={null} />)).toBe("");
  });
});

describe("RegistryEntriesPanel", () => {
  it("行が2つ以上なら、行ごとの住所と持分を表で出す", () => {
    const html = renderToStaticMarkup(<RegistryEntriesPanel registry={three} />);
    expect(html).toContain("所有者事項に 3 行");
    expect(html).toContain("東京都港区見本1-1-1");
    expect(html).toContain("3/10");
    expect(html).toContain("所有者事項からは分かりません");
  });

  it("行が1つだけ・記載が無いときは表を出さない(今までと同じ見た目)", () => {
    expect(renderToStaticMarkup(<RegistryEntriesPanel registry={one} />)).toBe("");
    expect(renderToStaticMarkup(<RegistryEntriesPanel registry={undefined} />)).toBe("");
  });

  it("住所が伏せられている行・持分が読めない行は「-」", () => {
    const html = renderToStaticMarkup(
      <RegistryEntriesPanel
        registry={{
          entries: [
            { position: 1, address: null, share: null },
            { position: 2, address: "住所B", share: { num: 1, den: 2 } },
          ],
          shareTotal: null,
        }}
      />,
    );
    expect(html).toContain(">-<");
  });

  it("⚠行の順に新旧の意味を持たせる言葉(最新・現在の住所)を書かない", () => {
    const html = renderToStaticMarkup(<RegistryEntriesPanel registry={three} />);
    expect(html).not.toMatch(/最新|最も新しい|現在の住所/);
  });
});

describe("物件の所有者カードへの組み込み(ソース)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("見出しに持分の札・見出しの下に内訳の表を置く", () => {
    expect(src).toContain("<RegistryShareBadge registry={po.registry} />");
    expect(src).toContain("<RegistryEntriesPanel registry={po.registry} />");
  });
});
