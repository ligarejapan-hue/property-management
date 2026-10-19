/**
 * カード(UIの統一 第2回・設計書 §3)。枠+角丸lg。interactive のときだけ乗せると持ち上がる。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, cardClassName } from "../card";

describe("Card", () => {
  it("枠+角丸lg+白/ダーク", () => {
    const html = renderToStaticMarkup(<Card>中身</Card>);
    expect(html).toContain("rounded-lg");
    expect(html).toContain("border-gray-200");
    expect(html).toContain("bg-white");
    expect(html).toContain("dark:bg-gray-900");
    expect(html).toContain("中身");
  });

  it("通常は動かない(持ち上がりは interactive だけ)", () => {
    expect(cardClassName()).not.toContain("hover:");
  });

  it("interactive: 乗せる/キーボードで選ぶと少し上がり枠が藍に・reduced-motion では上がらない", () => {
    const c = cardClassName(true);
    expect(c).toContain("hover:-translate-y-px");
    expect(c).toContain("hover:border-indigo-400");
    expect(c).toContain("hover:shadow-md");
    expect(c).toContain("focus-visible:border-indigo-400");
    expect(c).toContain("motion-reduce:hover:translate-y-0");
    expect(c).toContain("ease-out-soft");
  });

  it("className と他の属性を渡せる", () => {
    const html = renderToStaticMarkup(
      <Card className="p-4" data-testid="x">
        a
      </Card>,
    );
    expect(html).toContain("p-4");
    expect(html).toContain('data-testid="x"');
  });
});
