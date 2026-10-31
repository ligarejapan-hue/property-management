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
