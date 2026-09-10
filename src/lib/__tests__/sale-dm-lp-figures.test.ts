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
  it("文字が viewBox(640)の外へはみ出さない: 左寄せは x<=440・右寄せは x<=632(@codex R1 P2)", () => {
    for (const k of FIGURE_KINDS) {
      const svg = renderFigureSvg(k);
      const els = [...svg.matchAll(/<text\b([^>]*)>/g)].map((m) => m[1]);
      expect(els.length).toBeGreaterThan(0);
      for (const attrs of els) {
        const x = Number(/\bx="(-?[\d.]+)"/.exec(attrs)?.[1]);
        expect(Number.isFinite(x)).toBe(true);
        // text-anchor 未指定は SVG の既定 = start
        const anchor = /text-anchor="([a-z]+)"/.exec(attrs)?.[1] ?? "start";
        expect(["start", "middle", "end"]).toContain(anchor);
        expect(x).toBeGreaterThanOrEqual(0);
        if (anchor === "start") expect(x).toBeLessThanOrEqual(440);
        if (anchor === "end") expect(x).toBeLessThanOrEqual(632);
        if (anchor === "middle") { expect(x).toBeGreaterThanOrEqual(24); expect(x).toBeLessThanOrEqual(616); }
      }
    }
  });
  it("横棒の図: 補足は右寄せ(anchor=end・x=632)で、棒は補足の領域に食い込まない", () => {
    const NOTES: Record<string, string[]> = {
      cost_breakdown: ["価格×3%+6万円+税", "契約書に貼付", "抵当権抹消など", "利益が出た場合"],
      timing_by_type: ["築年数が浅いほど有利", "大規模修繕の前後が目安", "満室時・利回りが良い時", "地価と周辺開発の動き"],
    };
    for (const [kind, notes] of Object.entries(NOTES)) {
      const svg = renderFigureSvg(kind as (typeof FIGURE_KINDS)[number]);
      for (const note of notes) {
        // 補足そのものが「右端 632 で右寄せ」の <text> として出ている
        const escaped = note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(svg).toMatch(new RegExp(`<text x="632"[^>]*text-anchor="end"[^>]*>${escaped}</text>`));
      }
      // 棒(rect)の右端が 432 を超えない = 補足に 200px 以上残る
      const rects = [...svg.matchAll(/<rect x="(\d+)" y="\d+" width="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const bars = rects.filter(([x]) => x > 0); // 背景の全面 rect(x=0)は除く
      expect(bars.length).toBeGreaterThan(0);
      for (const [x, w] of bars) expect(x + w).toBeLessThanOrEqual(432);
    }
  });
  it("isFigureKind", () => {
    expect(isFigureKind("sale_flow")).toBe(true);
    expect(isFigureKind("nope")).toBe(false);
    expect(isFigureKind(null)).toBe(false);
  });
});
