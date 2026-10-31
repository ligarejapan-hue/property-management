import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NEXT_THEME_VALUES } from "@/lib/appearance/options";

// 見た目の設定 段階2(2026-10-31): テーマ・文字サイズ・印刷・白い紙の決まり。
const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "..", "globals.css"), "utf8").replace(/\r\n/g, "\n");

const themeBlock = (name: string) => {
  const m = css.match(new RegExp(`html\\[data-theme="${name}"\\] \\{([^}]*)\\}`));
  return m?.[1] ?? "";
};
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const PAINTED = ["blue", "washi", "navy", "forest", "paper"];

describe("色テーマ", () => {
  it.each(PAINTED)("%s は gray・indigo の11段・white・サイドバーの変数をすべて持つ", (name) => {
    const b = themeBlock(name);
    for (const s of STEPS) {
      expect(b, `gray-${s}`).toMatch(new RegExp(`--color-gray-${s}: #[0-9a-fA-F]{6};`));
      expect(b, `indigo-${s}`).toMatch(new RegExp(`--color-indigo-${s}: #[0-9a-fA-F]{6};`));
    }
    expect(b).toMatch(/--color-white: #/);
    for (const t of ["--side-bg", "--side-text", "--side-strong", "--side-active-bg", "--side-active-text", "--side-line", "--side-hover-bg", "--side-muted", "--side-faint", "--side-icon", "--logo-bg"]) {
      expect(b, t).toContain(`${t}:`);
    }
  });

  it.each(PAINTED)("%s は状態の色(赤・琥珀・緑)・iris・仲介/買取再販を差し替えない", (name) => {
    expect(themeBlock(name)).not.toMatch(/--color-(red|amber|yellow|green|emerald|iris)-|--(ok|warn|err)(-soft)?:|--c-(chukai|kaitori):/);
  });

  it("付録A の主ボタンの色がそのまま indigo-600 になる", () => {
    expect(themeBlock("blue")).toContain("--color-indigo-600: #2563EB;");
    expect(themeBlock("washi")).toContain("--color-indigo-600: #B7410E;");
    expect(themeBlock("navy")).toContain("--color-indigo-600: #1E3A8A;");
    expect(themeBlock("forest")).toContain("--color-indigo-600: #1F5F3A;");
    expect(themeBlock("paper")).toContain("--color-indigo-600: #9A3B12;");
  });

  it("html に付く値(NEXT_THEME_VALUES)のうち、色を塗るテーマは CSS に必ずある(スタンダード・ダークは既存の色)", () => {
    for (const v of Object.values(NEXT_THEME_VALUES)) {
      if (v === "standard" || v === "dark") continue;
      expect(themeBlock(v), v).not.toBe("");
    }
  });

  it("テーマの差し替えは html に置く(下の要素に置くと意味の変数が追従しない)", () => {
    expect(css).not.toMatch(/(?<!html)\[data-theme="(blue|washi|navy|forest|paper)"\] \{/);
  });

  it("和モダンは見出しだけ明朝", () => {
    expect(css).toMatch(/html\[data-theme="washi"\] h1,\s*html\[data-theme="washi"\] h2 \{\s*font-family: "Noto Serif JP"/);
  });
});

describe("印刷はどの設定でもスタンダード", () => {
  it("dark: は画面のときだけ効く", () => {
    expect(css).toMatch(/@custom-variant dark \{\s*@media screen \{\s*&:where\(\.dark, \.dark \*\) \{\s*@slot;/);
  });
  it(".dark の変数とテーマの差し替えは @media screen の中", () => {
    const darkAt = css.indexOf(".dark {");
    expect(css.lastIndexOf("@media screen {", darkAt)).toBeGreaterThan(-1);
    expect(css.slice(css.lastIndexOf("@media screen {", darkAt), darkAt).includes("}")).toBe(false);
    const blueAt = css.indexOf('html[data-theme="blue"] {');
    expect(css.slice(css.lastIndexOf("@media screen {", blueAt), blueAt)).not.toMatch(/\n\}/);
  });
});

describe("白い紙(.paper-sheet)はどのテーマでもスタンダードの色", () => {
  const b = css.match(/\.paper-sheet \{([^}]*)\}/)?.[1] ?? "";
  it("gray・indigo の11段と white を今の値に戻し、文字色を明示する", () => {
    for (const s of STEPS) {
      expect(b).toContain(`--color-gray-${s}: oklch(`);
      expect(b).toContain(`--color-indigo-${s}: oklch(`);
    }
    expect(b).toContain("--color-white: #fff;");
    expect(b).toContain("color: #171717;");
  });
});

describe("文字サイズ(密度)", () => {
  it("詰める・大きめは html の文字の大きさで全体を伸び縮み(標準は今まで=指定なし)", () => {
    expect(css).toMatch(/html\[data-density="compact"\] \{\s*font-size: 14px;/);
    expect(css).toMatch(/html\[data-density="large"\] \{\s*font-size: 18\.75px;/);
    expect(css).not.toMatch(/html\[data-density="normal"\]/);
  });
  it("大きめはチェック 26px・詰めるは 16px", () => {
    expect(css).toMatch(/html\[data-density="large"\] input:is\(\[type="checkbox"\], \[type="radio"\]\) \{\s*width: 26px;\s*height: 26px;/);
    expect(css).toMatch(/html\[data-density="compact"\] input:is\(\[type="checkbox"\], \[type="radio"\]\) \{\s*width: 16px;\s*height: 16px;/);
  });
});

describe("文字サイズも画面だけ(印刷は標準の大きさ)", () => {
  /** at の位置を囲んでいる一番内側の @ 規則の頭(波かっこの対応を数える)。 */
  const enclosingAtRule = (at: number) => {
    let depth = 0;
    for (let i = at - 1; i >= 0; i--) {
      if (css[i] === "}") depth++;
      else if (css[i] === "{") {
        if (depth === 0) return css.slice(css.lastIndexOf("\n", i) + 1, i).trim();
        depth--;
      }
    }
    return "";
  };
  it("html[data-density] の規則はすべて @media screen の中", () => {
    const hits = [...css.matchAll(/html\[data-density="(compact|large)"\][^{]*\{/g)];
    expect(hits.length).toBeGreaterThan(3);
    for (const m of hits) expect(enclosingAtRule(m.index ?? 0), m[0]).toBe("@media screen");
  });
  it("テーマの差し替えも @media screen の中", () => {
    const m = css.match(/html\[data-theme="washi"\] \{/);
    expect(enclosingAtRule(m?.index ?? 0)).toBe("@media screen");
  });
});
