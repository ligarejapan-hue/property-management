import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "OwnerArchiveButton.tsx"), "utf8");

describe("OwnerArchiveButton dark: 配色（22H・add-only）", () => {
  it("アーカイブ済みバッジ(neutral)に dark:bg-gray-700 dark:text-gray-200", () => {
    expect(src).toContain(
      "bg-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200",
    );
  });
  it("エラーパネル(red)に dark の border/bg/text", () => {
    expect(src).toContain(
      "bg-red-50 p-1.5 text-[11px] text-red-700 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300",
    );
  });
  it("閉じるリンク(red)に dark:text-red-300", () => {
    expect(src).toContain("text-red-600 underline dark:text-red-300");
  });
  it("確認パネル(amber)の地/枠に dark", () => {
    expect(src).toContain("bg-amber-50 p-2 text-xs dark:border-amber-400/20 dark:bg-amber-500/10");
  });
  it("確認見出し(amber-800)に dark:text-amber-300", () => {
    expect(src).toContain("text-amber-800 dark:text-amber-300");
  });
  it("キャンセルボタン(neutral)に dark の border/bg/text/hover", () => {
    expect(src).toContain(
      "text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800",
    );
  });
  it("判定中/アーカイブ中の薄文字に dark:text-gray-400", () => {
    expect(src).toContain("text-[11px] text-gray-500 dark:text-gray-400");
  });

  // ライト不変
  it("solid amber ボタン(bg-amber-600 text-white)は据え置き", () => {
    expect(src).toContain("bg-amber-600 px-2 py-1 text-xs font-medium text-white");
  });
});
