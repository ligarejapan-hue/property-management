import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar.tsx"),
  "utf-8",
);

describe("sidebar: company settings nav", () => {
  it("adminNavItems に /admin/company-settings を1件だけ持つ", () => {
    expect(src).toMatch(/href:\s*"\/admin\/company-settings"/);
    expect(src).toContain("会社情報");
    expect((src.match(/\/admin\/company-settings/g) ?? []).length).toBe(1);
  });
});
