import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "globals.css"),
  "utf8",
);

describe("globals.css ダークmode(class方式)", () => {
  it("@custom-variant dark がある", () => {
    expect(css).toContain("@custom-variant dark");
  });
  it(".dark で --foreground を切替える", () => {
    expect(css).toMatch(/\.dark\s*\{[^}]*--foreground/s);
  });
  it("壊れた @media (prefers-color-scheme: dark) は使わない", () => {
    expect(css).not.toContain("@media (prefers-color-scheme: dark)");
  });
});
