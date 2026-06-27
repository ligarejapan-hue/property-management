import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "OwnerMemoHistory.tsx"), "utf8");

describe("OwnerMemoHistory dark: 配色（22H・add-only）", () => {
  it("textarea に input系 dark(border/bg/text/placeholder)", () => {
    expect(src).toContain(
      "text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500",
    );
  });
  it("文字数カウンタ ternary に dark(red/gray)", () => {
    expect(src).toContain(
      'overLimit ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"',
    );
  });
  it("メモカード(bg-gray-50)に dark:border-gray-800 dark:bg-gray-800/50", () => {
    expect(src).toContain("bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-800/50");
  });
  it("作成者名(gray-700)に dark:text-gray-200", () => {
    expect(src).toContain("text-gray-700 dark:text-gray-200");
  });
  it("関連物件リンク(indigo)に dark:text-indigo-400", () => {
    expect(src).toContain("text-indigo-600 dark:text-indigo-400 hover:underline break-all");
  });
  it("メモ本文(gray-800)に dark:text-gray-100", () => {
    expect(src).toContain("text-sm text-gray-800 dark:text-gray-100");
  });
  it("submitError(red)に dark:text-red-400", () => {
    expect(src).toContain("mt-1 text-xs text-red-600 dark:text-red-400");
  });

  // ライト不変
  it("solid indigo ボタン(bg-indigo-600 text-white)は据え置き", () => {
    expect(src).toContain("bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white");
  });
  it("ライト bg-gray-50 が残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
});
