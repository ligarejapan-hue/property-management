import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

const dashboardLayout = readFileSync(
  join(dir, "..", "dashboard-layout.tsx"),
  "utf8"
);
const sidebar = readFileSync(join(dir, "..", "sidebar.tsx"), "utf8");
const css = readFileSync(join(dir, "..", "..", "..", "app", "globals.css"), "utf8").replace(/\r\n/g, "\n");
const darkBlock = css.slice(css.indexOf(".dark {"), css.indexOf("\n}", css.indexOf(".dark {")));

// 見た目の設定 段階1(2026-10-31): 枠の色は意味の名前の変数で書く。ダークの色は globals.css の .dark が受け持つ
// (今までの dark: クラスと同じ色を指す)。テーマ(段階2)で枠の色を差し替えられるようにするため。
describe("dashboard-layout dark: 配色", () => {
  it("外枠は bg-page(ダークでは gray-950)", () => {
    expect(dashboardLayout).toContain("bg-page");
    expect(darkBlock).toContain("--bg: var(--color-gray-950);");
  });
});

describe("sidebar dark: 配色", () => {
  it("枠の色は意味の名前だけで書き、灰色・藍を直接書かない", () => {
    expect(sidebar).not.toMatch(/(gray|indigo)-[0-9]{2,3}/);
  });
  it("aside 背景 = side-bg(ダークでは gray-900)", () => {
    expect(sidebar).toContain("bg-side-bg");
    expect(darkBlock).toContain("--side-bg: var(--color-gray-900);");
  });
  it("aside 境界 = side-line(ダークでは gray-700)", () => {
    expect(sidebar).toContain("border-side-line");
    expect(darkBlock).toContain("--side-line: var(--color-gray-700);");
  });
  it("メニューラベル = side-muted(ダークでは gray-400)", () => {
    expect(sidebar).toContain("text-side-muted");
    expect(darkBlock).toContain("--side-muted: var(--color-gray-400);");
  });
  it("通常リンク = side-text(ダークでは gray-300)", () => {
    expect(sidebar).toContain("text-side-text");
    expect(darkBlock).toContain("--side-text: var(--color-gray-300);");
  });
  it("リンク hover = side-hover-bg(ダークでは gray-800)", () => {
    expect(sidebar).toContain("hover:bg-side-hover-bg");
    expect(darkBlock).toContain("--side-hover-bg: var(--color-gray-800);");
  });
  it("active リンク = side-active-bg(ダークでは indigo-900)", () => {
    expect(sidebar).toContain("bg-side-active-bg");
    expect(darkBlock).toContain("--side-active-bg: var(--color-indigo-900);");
  });
});
