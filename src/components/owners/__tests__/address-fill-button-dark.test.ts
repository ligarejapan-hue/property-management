import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "AddressFillButton.tsx"), "utf8");

describe("AddressFillButton dark: 配色（22H・add-only）", () => {
  it("補完済みバッジに dark:bg-green-500/10 dark:text-green-300", () => {
    expect(src).toContain("text-green-700 dark:bg-green-500/10 dark:text-green-300");
  });
  it("エラー文に text-red-600 dark:text-red-400", () => {
    expect(src).toContain("text-red-600 dark:text-red-400");
  });
  it("確認パネル(blue)の地/枠に dark", () => {
    expect(src).toContain("bg-blue-50 p-2 text-xs dark:border-blue-400/20 dark:bg-blue-500/10");
  });
  it("確認パネルの見出し(blue-800)に dark:text-blue-300", () => {
    expect(src).toContain("text-blue-800 dark:text-blue-300");
  });
  it("キャンセルボタン(neutral)に dark の border/bg/text/hover", () => {
    expect(src).toContain(
      "text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800",
    );
  });
  it("補完中の薄文字に dark:text-gray-400", () => {
    expect(src).toContain("text-gray-500 dark:text-gray-400");
  });

  // ライト不変ガード
  it("solid indigo ボタン(bg-indigo-600 text-white)は据え置き", () => {
    expect(src).toContain("bg-indigo-600 px-2 py-1 text-xs font-medium text-white");
  });
  it("ライト bg-blue-50 が残っている", () => {
    expect(src).toContain("bg-blue-50");
  });
});
