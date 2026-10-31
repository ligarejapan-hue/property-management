import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_SWATCHES, DENSITY_ROOT_PX } from "../swatches";
import { THEME_OPTIONS } from "../options";

// 設定 > 表示 の見本の色が、実際のテーマ(globals.css)とずれていないか。
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8").replace(/\r\n/g, "\n");

function themeVars(name: string): Record<string, string> {
  const m = css.match(new RegExp(`html\\[data-theme="${name}"\\] \\{([^}]*)\\}`));
  if (!m) throw new Error(`no theme ${name}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+): (#[0-9a-fA-F]{6});/g)].map((d) => [d[1], d[2].toLowerCase()]));
}

describe("THEME_SWATCHES", () => {
  it("自動以外の全テーマに見本がある", () => {
    expect(Object.keys(THEME_SWATCHES).sort()).toEqual(THEME_OPTIONS.map((o) => o.value).filter((v) => v !== "auto").sort());
  });
  it.each(["blue", "washi", "navy", "forest", "paper"] as const)("%s は globals.css の値と同じ", (name) => {
    const v = themeVars(name);
    const s = THEME_SWATCHES[name];
    expect(s).toEqual({
      page: v["color-gray-50"],
      surface: v["color-white"],
      line: v["color-gray-200"],
      text: v["color-gray-900"],
      muted: v["color-gray-400"],
      accent: v["color-indigo-600"],
      side: v["side-bg"],
      sideText: v["side-text"],
      sideActive: v["side-active-bg"],
    });
  });
});

describe("DENSITY_ROOT_PX", () => {
  it("globals.css の文字サイズと同じ(詰める 14px・大きめ 18.75px)", () => {
    expect(css).toMatch(new RegExp(`html\\[data-density="compact"\\] \\{\\s*font-size: ${DENSITY_ROOT_PX.compact}px;`));
    expect(css).toMatch(new RegExp(`html\\[data-density="large"\\] \\{\\s*font-size: ${DENSITY_ROOT_PX.large}px;`));
  });
});

// 2026-10-31 発注者「直す」: スタンダードの注記(gray-400)は白地 2.59・背景 2.48 で 3 に届かなかった → 明るさだけ下げて 3:1 以上に。
// ダークは基準以上だったので今の見た目のまま(.dark で元の値に戻す)。紙の見本(.paper-sheet)は印刷物とそろえるため元の値のまま。
describe("スタンダードの注記の色", () => {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const block = (start: string) => css.slice(css.indexOf(start), css.indexOf("}", css.indexOf(start)));

  it("@theme の gray-400 は明るさだけ下げた値(色合いは stone のまま)", () => {
    expect(block("--color-gray-50: oklch(98.5%")).toContain("--color-gray-400: oklch(65.4% 0.01 56.259);");
  });
  it("見本の色も同じ値で、白地・背景とも 3:1 以上", () => {
    const s = THEME_SWATCHES.standard;
    expect(s.muted).toBe("#958f8b");
    expect(ratio(s.muted, s.surface)).toBeGreaterThanOrEqual(3);
    expect(ratio(s.muted, s.page)).toBeGreaterThanOrEqual(3);
  });
  it("ダークは今の値のまま", () => {
    expect(block(".dark {")).toContain("--color-gray-400: oklch(70.9% 0.01 56.259);");
    expect(THEME_SWATCHES.dark.muted).toBe("#a6a09b");
  });
  it("紙の見本は印刷物とそろえて元の値のまま", () => {
    expect(block(".paper-sheet {")).toContain("--color-gray-400: oklch(70.9% 0.01 56.259);");
  });
});
