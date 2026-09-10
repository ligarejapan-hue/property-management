import { describe, it, expect } from "vitest";
import { FIGURE_KINDS, FIGURE_LABELS, isFigureKind, renderFigureSvg } from "../sale-dm-letter/lp-figures";

describe("renderFigureSvg", () => {
  it("5種すべてが完結した SVG を返し、日本語の名前を持つ", () => {
    expect(FIGURE_KINDS.length).toBe(5);
    for (const k of FIGURE_KINDS) {
      const svg = renderFigureSvg(k);
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 640 360"');
      expect(svg).toContain("<text");
      expect(FIGURE_LABELS[k].length).toBeGreaterThan(0);
    }
  });
  it("外部参照(url()/href=http/script)を含まない", () => {
    for (const k of FIGURE_KINDS) {
      const svg = renderFigureSvg(k);
      expect(svg).not.toMatch(/<script|href="http|url\(|<image/i);
    }
  });
  it("同じ種類は常に同じ文字列(決定的)", () => {
    expect(renderFigureSvg("sale_flow")).toBe(renderFigureSvg("sale_flow"));
  });
  it("図ごとの要点の文字が入っている", () => {
    expect(renderFigureSvg("sale_flow")).toContain("査定");
    expect(renderFigureSvg("sale_flow")).toContain("引渡し");
    expect(renderFigureSvg("cost_breakdown")).toContain("仲介手数料");
    expect(renderFigureSvg("inheritance_deadlines")).toContain("3年");
    expect(renderFigureSvg("inheritance_deadlines")).toContain("10か月");
    expect(renderFigureSvg("vacant_burden")).toContain("固定資産税");
    expect(renderFigureSvg("timing_by_type")).toContain("戸建");
  });
  it("isFigureKind", () => {
    expect(isFigureKind("sale_flow")).toBe(true);
    expect(isFigureKind("nope")).toBe(false);
    expect(isFigureKind(null)).toBe(false);
  });
});
