import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "import-switcher.tsx"), "utf8");

describe("import-switcher.tsx dark: 配色", () => {
  it("アクティブタブ文字に dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });
  it("アクティブタブ枠線に dark:border-indigo-400 がある", () => {
    expect(src).toContain("dark:border-indigo-400");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("ライト側 text-indigo-700 は残っている", () => {
    expect(src).toContain("text-indigo-700");
  });
  it("ライト側 border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
});
