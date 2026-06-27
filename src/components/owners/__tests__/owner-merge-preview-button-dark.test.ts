import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "OwnerMergePreviewButton.tsx"), "utf8");

describe("OwnerMergePreviewButton dark: 配色（22H・add-only）", () => {
  it("プレビューボタンの disabled 地に dark:disabled:bg-gray-700", () => {
    expect(src).toContain("disabled:bg-gray-300 dark:disabled:bg-gray-700");
  });
  it("閉じるリンクに dark:text-gray-400 dark:hover:text-gray-300", () => {
    expect(src).toContain(
      "text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300",
    );
  });
  it("通信エラーバナー(red)に dark の border/bg/text", () => {
    expect(src).toContain(
      "bg-red-50 p-2 text-xs text-red-700 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300",
    );
  });
  it("結果パネル eligible 分岐(green)に dark", () => {
    expect(src).toContain(
      "border-green-200 bg-green-50 dark:border-green-400/20 dark:bg-green-500/10",
    );
  });
  it("結果パネル 不可分岐(red)に dark", () => {
    expect(src).toContain("border-red-200 bg-red-50 dark:border-red-400/20 dark:bg-red-500/10");
  });
  it("結果見出しの分岐色に dark(green/red)", () => {
    expect(src).toContain(
      'result.eligible ? "text-green-800 dark:text-green-300" : "text-red-800 dark:text-red-300"',
    );
  });
  it("summary dl(gray-700)に dark:text-gray-200", () => {
    expect(src).toContain("text-gray-700 dark:text-gray-200");
  });
  it("OwnerMemo 強調(amber)に dark:text-amber-300", () => {
    expect(src).toContain("font-bold text-amber-700 dark:text-amber-300");
  });
  it("実行警告box(red-300)に dark の border/bg", () => {
    expect(src).toContain("border border-red-300 bg-red-50 p-2 dark:border-red-400/20 dark:bg-red-500/10");
  });
  it("キャンセルボタン(neutral)に dark", () => {
    expect(src).toContain(
      "text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800",
    );
  });
  it("統合完了 success box(green)に dark", () => {
    expect(src).toContain(
      "bg-green-50 p-2 text-xs text-green-800 dark:border-green-400/20 dark:bg-green-500/10 dark:text-green-300",
    );
  });

  // ライト不変（solid colored buttons は据え置き）
  it("solid purple プレビューボタン据え置き", () => {
    expect(src).toContain("bg-purple-600 px-3 py-1 text-xs font-medium text-white");
  });
  it("solid red 実行ボタン据え置き", () => {
    expect(src).toContain("bg-red-600 px-3 py-1 text-xs font-medium text-white");
  });
});
