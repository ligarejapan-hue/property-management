import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "field-survey-history-map.tsx"), "utf8");

describe("field-survey-history-map.tsx — 履歴モードバナー dark: (blue accent)", () => {
  // 履歴閲覧中バナーは青 accent 地 → dark:bg-blue-500/20 dark:text-blue-300
  it("履歴バナーに dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });
  it("履歴バナー文字に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("履歴バナー枠線に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });
});

describe("field-survey-history-map.tsx — 通常マップへ戻るボタン dark:", () => {
  // bg-white px-2 py-1 のボタンは地図外 chrome → dark:bg-gray-900
  it("戻るボタンに dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("戻るボタン文字に dark:text-blue-400 がある", () => {
    expect(src).toContain("dark:text-blue-400");
  });
  it("戻るボタン枠線に dark:border-blue-500/40 がある", () => {
    // バナー枠線と同じ値
    expect(src).toContain("dark:border-blue-500/40");
  });
  it("戻るボタンホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });
});

describe("field-survey-history-map.tsx — エラー/pinsTruncated バナー dark: (amber accent)", () => {
  // amber バナーは dark:bg-amber-500/15 dark:text-amber-300
  it("エラーバナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("エラーバナー文字に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("エラーバナー枠線に dark:border-amber-500/30 がある", () => {
    expect(src).toContain("dark:border-amber-500/30");
  });
});

describe("field-survey-history-map.tsx — ローディングオーバーレイ dark:", () => {
  // bg-white/90 のオーバーレイ → dark:bg-gray-900/90 dark:text-gray-300
  it("ローディングオーバーレイに dark:bg-gray-900/90 がある", () => {
    expect(src).toContain("dark:bg-gray-900/90");
  });
  it("ローディング文字に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
});

describe("field-survey-history-map.tsx — ライト側不変担保", () => {
  it("bg-blue-50 は残っている", () => {
    expect(src).toContain("bg-blue-50");
  });
  it("text-blue-900 は残っている", () => {
    expect(src).toContain("text-blue-900");
  });
  it("border-blue-200 は残っている", () => {
    expect(src).toContain("border-blue-200");
  });
  it("bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("text-blue-700 は残っている", () => {
    expect(src).toContain("text-blue-700");
  });
  it("bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  it("text-amber-900 は残っている", () => {
    expect(src).toContain("text-amber-900");
  });
  it("border-amber-300 は残っている", () => {
    expect(src).toContain("border-amber-300");
  });
  it("bg-white/90 は残っている", () => {
    expect(src).toContain("bg-white/90");
  });
  it("text-gray-700 は残っている (ローディング文字)", () => {
    expect(src).toContain("text-gray-700");
  });
});
