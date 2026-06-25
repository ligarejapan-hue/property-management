import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "insecure-context-banner.tsx"), "utf8");

describe("insecure-context-banner.tsx — amber accent バナー dark:", () => {
  // バナーボックスは amber accent 地 (neutral=0) →
  // dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30
  it("バナーボックスに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("バナー本文に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("バナー枠線に dark:border-amber-500/30 がある", () => {
    expect(src).toContain("dark:border-amber-500/30");
  });
  it("バナー副文字に dark:text-amber-400 がある", () => {
    expect(src).toContain("dark:text-amber-400");
  });
});

describe("insecure-context-banner.tsx — ライト側不変担保", () => {
  it("border-amber-300 は残っている", () => {
    expect(src).toContain("border-amber-300");
  });
  it("bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  it("text-amber-900 は残っている", () => {
    expect(src).toContain("text-amber-900");
  });
  it("text-amber-800 は残っている", () => {
    expect(src).toContain("text-amber-800");
  });
});
