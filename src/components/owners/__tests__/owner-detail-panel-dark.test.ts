import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "owner-detail-panel.tsx"), "utf8");

describe("owner-detail-panel dark: 配色（22H・add-only）", () => {
  it("パネル面(bg-gray-50)に dark:border-gray-800 dark:bg-gray-900", () => {
    expect(src).toContain(
      "border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-gray-900",
    );
  });
  it("ラベルに text-gray-500 dark:text-gray-400", () => {
    expect(src).toContain("text-gray-500 dark:text-gray-400");
  });
  it("値に text-sm text-gray-900 dark:text-gray-100", () => {
    expect(src).toContain("text-sm text-gray-900 dark:text-gray-100");
  });
  it("非表示muted に text-gray-400 dark:text-gray-500", () => {
    expect(src).toContain("text-gray-400 dark:text-gray-500");
  });
  it("法人番号疑い amber 警告パネルに dark の bg/border/text", () => {
    expect(src).toContain(
      "bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-300",
    );
  });

  // ライト不変ガード
  it("ライト bg-gray-50 が残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライト text-gray-900 が残っている", () => {
    expect(src).toContain("text-gray-900");
  });
});
