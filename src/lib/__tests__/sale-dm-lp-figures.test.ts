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
  it("中央寄せの文字は、文字の幅まで数えても viewBox(640)を出ない: x + 文字数×font-size÷2 <= 640", () => {
    // 和文は 1 文字 ≒ font-size ぶんの幅。中央寄せは左右へ半分ずつ伸びるので、
    // 右端 = x + 文字数 × font-size ÷ 2。5種すべてに同じ物差しを当てる。
    for (const k of FIGURE_KINDS) {
      const svg = renderFigureSvg(k);
      const els = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)];
      expect(els.length).toBeGreaterThan(0);
      let middles = 0;
      for (const [, attrs, body] of els) {
        const anchor = /text-anchor="([a-z]+)"/.exec(attrs)?.[1] ?? "start";
        if (anchor !== "middle") continue;
        middles += 1;
        const x = Number(/\bx="(-?[\d.]+)"/.exec(attrs)?.[1]);
        const fontSize = Number(/font-size="([\d.]+)"/.exec(attrs)?.[1]);
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(fontSize)).toBe(true);
        // 属性値ではなく描かれる文字を数える(実体参照を戻してから)
        const label = body
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&");
        const half = 0.5 * label.length * fontSize;
        expect(x + half).toBeLessThanOrEqual(640);
        expect(x - half).toBeGreaterThanOrEqual(0);
      }
      // 中央寄せが1つも無い図があってもよい(横棒の図など)
      expect(middles).toBeGreaterThanOrEqual(0);
    }
    // 相続の期限: 最後の目盛りだけは右端 632 に end 寄せ(中央寄せのままだと縁で切れる)
    const deadlines = renderFigureSvg("inheritance_deadlines");
    expect(deadlines).toMatch(/<text x="632"[^>]*text-anchor="end"[^>]*>空き家特例の目安<\/text>/);
    expect(deadlines).toMatch(/<text x="632"[^>]*text-anchor="end"[^>]*>3年目の年末<\/text>/);
    expect(deadlines).not.toContain('<circle cx="632"');
    expect(deadlines).toContain('<circle cx="592" cy="180" r="8"');
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
