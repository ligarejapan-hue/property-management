import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// dmSentMax(送信回数フィルタ)は buildPropertyListWhere 経由で export 系にも効くため、
// 監査ログの filtersForLog(AUDIT_FILTER_KEYS)にも載せる(非PII・@codex R5)。
const routes = [
  "src/app/api/properties/export/route.ts",
  "src/app/api/properties/dm-export/route.ts",
  "src/app/api/properties/property-dm-export/route.ts",
];

describe("export routes: dmSentMax を監査フィルタに含める", () => {
  for (const r of routes) {
    it(`${r} の AUDIT_FILTER_KEYS に "dmSentMax" がある`, () => {
      const src = readFileSync(path.resolve(process.cwd(), r), "utf-8");
      expect(src).toMatch(/AUDIT_FILTER_KEYS\s*=\s*\[[\s\S]*?"dmSentMax"[\s\S]*?\]/);
    });
  }
});
