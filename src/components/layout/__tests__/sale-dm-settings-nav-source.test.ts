import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar-model.tsx"),
  "utf-8",
);

describe("sidebar: sale DM settings nav", () => {
  it("adminNavItems に /admin/sale-dm-settings を1件だけ持つ", () => {
    expect(src).toMatch(/href:\s*"\/admin\/sale-dm-settings"/);
    expect(src).toContain("売却DM設定");
    expect((src.match(/\/admin\/sale-dm-settings/g) ?? []).length).toBe(1);
  });
});
