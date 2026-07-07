import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar.tsx"),
  "utf-8",
);

describe("sidebar: registry settings nav", () => {
  it("adminNavItems に /admin/registry-settings を1件だけ持つ", () => {
    expect(src).toMatch(/href:\s*"\/admin\/registry-settings"/);
    expect(src).toContain("謄本取得の資格情報");
    expect((src.match(/\/admin\/registry-settings/g) ?? []).length).toBe(1);
  });
});
