import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 見た目の設定 段階1(2026-10-31): 色・文字サイズ・余白を意味の名前の変数経由にする(見た目は変えない)。
const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..", "..", "..");
const css = readFileSync(join(dir, "..", "globals.css"), "utf8").replace(/\r\n/g, "\n");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

/** `selector {` から対応する `}` までの中身(入れ子なしのブロック用)。 */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  return css.slice(start, css.indexOf("\n}", start));
}

const COLOR_TOKENS = [
  "--bg", "--surface", "--surface-2", "--line", "--line-2",
  "--text", "--text-2", "--text-3",
  "--accent", "--accent-ink", "--accent-soft", "--accent-text",
  "--ok", "--ok-soft", "--warn", "--warn-soft", "--err", "--err-soft",
  "--side-bg", "--side-text", "--side-strong", "--side-active-bg", "--side-active-text", "--side-line",
  "--side-hover-bg", "--side-hover-text", "--side-muted", "--side-faint", "--side-icon", "--side-muted-hover",
  "--logo-bg", "--logo-ink",
  "--c-chukai", "--c-kaitori",
];
const DENSITY_TOKENS = [
  "--fs", "--fs-sm", "--h1", "--h2", "--kv",
  "--row-py", "--pad", "--gap", "--btn-h", "--input-h", "--ic", "--border-w", "--r", "--r-sm",
];

describe("意味の名前の変数(付録A・B の名前)", () => {
  const light = block(":root");
  const dark = block(".dark");

  it.each(COLOR_TOKENS)("%s が :root に定義されている", (t) => {
    expect(light).toMatch(new RegExp(`\\n\\s*${t}:`));
  });

  it.each(DENSITY_TOKENS)("文字サイズの %s が :root に定義されている", (t) => {
    expect(light).toMatch(new RegExp(`\\n\\s*${t}:`));
  });

  it("ダークは、色の変数をすべて上書きする(仲介/買取再販は別)", () => {
    for (const t of COLOR_TOKENS.filter((x) => !/^--c-/.test(x))) {
      expect(dark, t).toMatch(new RegExp(`\\n\\s*${t}:`));
    }
  });

  it("スタンダードの値は今の見た目と同じ = Tailwind の色の変数を指す(新しい色の値を持ち込まない)", () => {
    expect(light).toMatch(/--surface: var\(--color-white\)/);
    expect(light).toMatch(/--bg: var\(--color-gray-50\)/);
    expect(light).toMatch(/--accent: var\(--color-indigo-600\)/);
    expect(dark).toMatch(/--bg: var\(--color-gray-950\)/);
  });

  it("状態の色(赤・黄・緑)は、テーマで差し替えない色(red/amber/green)を指す(ダークでも同じ色相)", () => {
    expect(dark).toMatch(/--ok: var\(--color-green-/);
    expect(dark).toMatch(/--warn-soft: var\(--color-amber-/);
    expect(dark).toMatch(/--err-soft: var\(--color-red-/);
    expect(light).toMatch(/--ok: var\(--color-green-/);
    expect(light).toMatch(/--warn: var\(--color-amber-/);
    expect(light).toMatch(/--err: var\(--color-red-/);
  });

  it("Tailwind のクラス名(bg-surface・text-fg-2・bg-side-bg など)として使える", () => {
    const inline = css.slice(css.indexOf("@theme inline"), css.indexOf("}", css.indexOf("@theme inline")));
    for (const name of ["page", "surface", "surface-2", "line", "fg", "fg-2", "fg-3", "accent", "accent-soft", "accent-text", "ok", "warn", "err", "side-bg", "side-active-bg", "chukai", "kaitori"]) {
      expect(inline, name).toMatch(new RegExp(`--color-${name}: var\\(`));
    }
  });
});

describe("テーマで変わらない藍の写し(iris)", () => {
  it("iris の11段が Tailwind 既定の indigo と同じ値で定義されている", () => {
    const tw = readFileSync(join(root, "node_modules", "tailwindcss", "theme.css"), "utf8");
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      const want = tw.match(new RegExp(`--color-indigo-${step}: ([^;]+);`))?.[1];
      expect(want, `indigo-${step}`).toBeTruthy();
      expect(css).toContain(`--color-iris-${step}: ${want};`);
    }
  });

  // 調査(2026-10-31): 藍が「状態・種類の色の組の1つ」として使われている箇所。テーマで色が変わると意味が崩れるので iris に。
  const EXCLUDED: Array<[string, RegExp]> = [
    ["src/app/(dashboard)/buildings/[id]/page.tsx", /rented: "bg-iris-100 text-iris-800"/],
    ["src/components/ui/notification-panel.tsx", /indigo: "bg-iris-50 text-iris-600/],
    ["src/components/ui/toast-stack.tsx", /border-l-iris-500/],
    ["src/components/properties/photo-tab.tsx", /"bg-iris-200"/],
    ["src/components/properties/action-bar.tsx", /selectedColor: "bg-iris-600/],
    ["src/components/sale-dm/recipient-list.tsx", /bg-iris-100[^"]*text-iris-700/],
    ["src/components/sale-dm/aggregate-view.tsx", /text-iris-700/],
  ];
  it.each(EXCLUDED)("%s は状態・種類の藍を iris で書く", (file, re) => {
    expect(read(file)).toMatch(re);
  });
});
