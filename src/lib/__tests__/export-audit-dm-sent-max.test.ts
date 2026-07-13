import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";

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

describe("audit 表示: dmSentMax はサニタイズで残る(REDACTED にしない・@codex R14)", () => {
  it("filters.dmSentMax=0 は表示許可(監査者が未送信フィルタで絞ったか確認できる)", () => {
    const out = sanitizeAuditDetail("property_csv_export", { filters: { dmSentMax: 0 } }) as {
      filters: { dmSentMax: unknown };
    };
    expect(out.filters.dmSentMax).toBe(0);
  });
});
