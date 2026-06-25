import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "field-survey-map-client.tsx"), "utf8");

describe("field-survey-map-client.tsx — fallback wrapper dark:", () => {
  // bg-gray-50 の外側ラッパーは chrome (地図を読み込まない状態の背景)。
  it("外側ラッパーに dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
});

describe("field-survey-map-client.tsx — amber fallback バナー dark: (accent)", () => {
  // MissingMapIdFallback / BillingNotAcknowledgedFallback / MissingKeyNotice は
  // amber accent 地のバナー → dark:bg-amber-500/15 dark:text-amber-300
  it("amber バナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("amber バナー見出しに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("amber バナー副文字に dark:text-amber-400 がある", () => {
    expect(src).toContain("dark:text-amber-400");
  });
  it("amber バナー枠線に dark:border-amber-500/30 がある", () => {
    expect(src).toContain("dark:border-amber-500/30");
  });
});

describe("field-survey-map-client.tsx — code スニペット背景 dark:", () => {
  // <code> 内の bg-white は小さな chrome → dark:bg-gray-800
  it("code 要素に dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });
});

describe("field-survey-map-client.tsx — ライト側不変担保", () => {
  it("bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
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
  it("border-amber-300 は残っている", () => {
    expect(src).toContain("border-amber-300");
  });
  it("bg-white は残っている (code 要素)", () => {
    expect(src).toContain("bg-white");
  });
});
