import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "theme-toggle.tsx"),
  "utf8",
);

// 見た目の設定 段階2(2026-10-31): 自動/明るい/暗い の3つボタン → 色テーマ(自動+7つ)と文字サイズの選択。
describe("theme-toggle.tsx (source-assertion)", () => {
  it("is a client component", () => {
    expect(src).toContain('"use client"');
  });
  it("色は next-themes の setTheme で即時に切り替える(自動=system・スタンダード=light に変換)", () => {
    expect(src).toContain("useTheme");
    expect(src).toContain("next-themes");
    expect(src).toMatch(/setTheme\(toNextTheme\(v\)\)/);
  });
  it("選択肢は options.ts の1か所から(ここに選択肢を直書きしない)", () => {
    expect(src).toContain("THEME_OPTIONS.filter");
    expect(src).toContain("DENSITY_OPTIONS.map");
    expect(src).not.toMatch(/"和モダン"|"紺と金"|"明るい"|"暗い"/);
  });
  it("選んだら DB に保存する(保存の中身は lib/appearance/client.ts)", () => {
    expect(src).toMatch(/saveAppearance\(\{ theme: v \}\)/);
    expect(src).toMatch(/saveAppearance\(\{ density: v \}\)/);
  });
  it("文字サイズは html の値を1か所の正として購読する(ヘッダーとメニューの選択欄が食い違わない・@codex #618)", () => {
    expect(src).toMatch(/useSyncExternalStore<DensityPref>\(subscribeAppearance, readDensity,/);
    expect(src).toContain("applyDensity(v)");
    expect(src).not.toMatch(/useState<DensityPref>/);
  });
  it("選択欄に読み上げ用の名前がある(キーボード・読み上げで選べる)", () => {
    expect(src).toContain('aria-label="色テーマ"');
    expect(src).toContain('aria-label="文字サイズ"');
  });
  it("色は会社が選べる色を絞っていればそれだけ(段階4)・「配置」はここに出さない", () => {
    expect(src).toContain("loadPreferences()");
    expect(src).toContain("allowed.includes(o.value)");
    expect(src).toContain("themeChoices.map");
    expect(src).not.toContain("withLayout");
    expect(src).not.toContain("メニューの配置");
  });
  it("選べる色が変わったら一覧を合わせる(スマホのメニューは作り直されない・@codex #623)", () => {
    expect(src).toContain("window.addEventListener(PREFERENCES_SAVED_EVENT, onUpdate)");
    expect(src).toContain("window.removeEventListener(PREFERENCES_SAVED_EVENT, onUpdate)");
  });
  it("exports ThemeToggle function", () => {
    expect(src).toMatch(/export\s+function\s+ThemeToggle/);
  });
});
