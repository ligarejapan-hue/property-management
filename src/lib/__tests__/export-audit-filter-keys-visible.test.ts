import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";

/**
 * 検索条件を監査に残す3つの export 系 route の**走査型ガード**。
 *
 * 監査に条件を残すには**2段**そろっている必要がある:
 *   ①route の `AUDIT_FILTER_KEYS` に載せる(そもそも書き込まれない)
 *   ②`audit-log-detail-safety.ts` の allowlist に載せる(書いても表示で [REDACTED])
 * ①だけ直して②を忘れると、記録はされるのに監査画面では見えない=気づけない。
 *
 * ⚠キー名を手で並べない。route のソースから `AUDIT_FILTER_KEYS` を読み取って
 * 総当たりするので、**将来 新しいフィルタを足したときの②の抜けも自動で落ちる**。
 * (PR-C の resendOnly で実際に②を忘れた=@codex #374 R3)
 */
const ROUTES = [
  {
    file: "src/app/api/properties/export/route.ts",
    action: "property_csv_export",
  },
  {
    file: "src/app/api/properties/dm-batches/route.ts",
    action: "dm_batch_create",
  },
  {
    file: "src/app/api/properties/property-dm-export/route.ts",
    action: "property_address_dm_csv_export",
  },
] as const;

function auditFilterKeys(file: string): string[] {
  const src = readFileSync(path.resolve(process.cwd(), file), "utf-8");
  const m = src.match(/AUDIT_FILTER_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!m) throw new Error(`AUDIT_FILTER_KEYS が見つからない: ${file}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("export系routeの監査フィルタ: 記録したキーが表示でも消えない", () => {
  for (const { file, action } of ROUTES) {
    it(`${file}: AUDIT_FILTER_KEYS の全キーが sanitize を通る`, () => {
      const keys = auditFilterKeys(file);
      expect(keys.length).toBeGreaterThan(0);
      // 値は非PIIのダミー(キーが allowlist にあるかだけを見る)
      const filters = Object.fromEntries(keys.map((k) => [k, "x"]));
      const out = sanitizeAuditDetail(action, { filters }) as {
        filters: Record<string, unknown>;
      };
      const redacted = keys.filter((k) => out.filters[k] !== "x");
      expect(redacted).toEqual([]);
    });
  }

  for (const { file } of ROUTES) {
    it(`${file}: 再送候補フィルタ(resendOnly)を記録する`, () => {
      expect(auditFilterKeys(file)).toContain("resendOnly");
    });
  }
});
