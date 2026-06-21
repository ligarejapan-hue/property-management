import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const loginPage = readFileSync(join(dir, "..", "page.tsx"), "utf8");

// 入力欄の行 (placeholder:text-gray-400 を含む行) に light/dark の両クラスがあること
const inputLines = loginPage
  .split("\n")
  .filter((line) => line.includes("placeholder:text-gray-400"));

describe("login page dark: 配色", () => {
  it("カードに dark:bg-gray-900 がある", () => {
    expect(loginPage).toContain("dark:bg-gray-900");
  });
  it("カードに dark:border-gray-800 がある", () => {
    expect(loginPage).toContain("dark:border-gray-800");
  });
  it("入力欄に text-gray-900 がある (placeholder:text-gray-400 と同行)", () => {
    expect(inputLines.length).toBeGreaterThan(0);
    inputLines.forEach((line) => {
      expect(line).toContain("text-gray-900");
    });
  });
  it("入力欄に dark:text-gray-100 がある (placeholder:text-gray-400 と同行)", () => {
    expect(inputLines.length).toBeGreaterThan(0);
    inputLines.forEach((line) => {
      expect(line).toContain("dark:text-gray-100");
    });
  });
  it("入力欄に dark:bg-gray-900 がある (placeholder:text-gray-400 と同行)", () => {
    inputLines.forEach((line) => {
      expect(line).toContain("dark:bg-gray-900");
    });
  });
  it("入力欄に dark:border-gray-700 がある (placeholder:text-gray-400 と同行)", () => {
    inputLines.forEach((line) => {
      expect(line).toContain("dark:border-gray-700");
    });
  });
  it("placeholder:text-gray-400 は維持されている", () => {
    expect(loginPage).toContain("placeholder:text-gray-400");
  });
});
