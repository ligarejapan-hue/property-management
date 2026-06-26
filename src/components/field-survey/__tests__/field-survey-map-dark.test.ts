import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "field-survey-map.tsx"), "utf8");

describe("field-survey-map.tsx — ControlPanel chrome dark:", () => {
  // ControlPanel は地図の外側に浮く chrome パネル (bg-white border-gray-200)。
  it("ControlPanel 背景に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("ControlPanel 枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("ControlPanel 見出し文字に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
});

describe("field-survey-map.tsx — 地図上ローディングオーバーレイ dark:", () => {
  // bg-white/90 のオーバーレイを暗面でも判別できるよう dark 化する。
  it("ローディングオーバーレイに dark:bg-gray-900/90 がある", () => {
    expect(src).toContain("dark:bg-gray-900/90");
  });
  it("ローディング文字に dark:text-gray-300 がある", () => {
    // 文字の dark が存在すれば OK（ControlPanel と共用の値）
    expect(src).toContain("dark:text-gray-300");
  });
});

describe("field-survey-map.tsx — エラーアラート dark: (red accent)", () => {
  // 赤バナー（absolute bottom）は accent = dark:bg-red-500/10 dark:text-red-300
  it("エラーバナーに dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナーに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("エラーバナー枠に dark:border-red-500/30 がある", () => {
    expect(src).toContain("dark:border-red-500/30");
  });
});

describe("field-survey-map.tsx — ライト側不変担保", () => {
  it("bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("bg-red-50 は残っている", () => {
    expect(src).toContain("bg-red-50");
  });
  it("text-red-800 は残っている", () => {
    expect(src).toContain("text-red-800");
  });
  it("bg-white/90 は残っている", () => {
    expect(src).toContain("bg-white/90");
  });
});
