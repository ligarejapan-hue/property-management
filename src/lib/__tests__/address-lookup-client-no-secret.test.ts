/**
 * #9: client 側(api-client.ts)に APIキーや server provider が出ないことを
 * ソースレベルで保証する。client bundle へ ADDRESS_LOOKUP_API_KEY が混入しない設計を固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const clientSrc = readFileSync(
  resolve(process.cwd(), "src/lib/api-client.ts"),
  "utf8",
);

describe("api-client は住所補完APIキー/secret を露出しない", () => {
  it("ADDRESS_LOOKUP_API_KEY を参照しない", () => {
    expect(clientSrc).not.toContain("ADDRESS_LOOKUP_API_KEY");
  });

  it("process.env.ADDRESS_LOOKUP を読まない(server 専用)", () => {
    expect(clientSrc).not.toContain("process.env.ADDRESS_LOOKUP");
  });

  it("server provider(japanpost-provider) を runtime import しない", () => {
    expect(clientSrc).not.toContain("japanpost-provider");
  });

  it("orchestrator(./address-lookup index, env を読む) を runtime import しない", () => {
    expect(clientSrc).not.toMatch(/from\s+["']\.\/address-lookup["']/);
  });

  it("候補の型は type-only import で取得する", () => {
    expect(clientSrc).toMatch(
      /import\s+type\s+\{[^}]*AddressLookupCandidate[^}]*\}\s+from\s+["']\.\/address-lookup\/types["']/,
    );
  });
});
