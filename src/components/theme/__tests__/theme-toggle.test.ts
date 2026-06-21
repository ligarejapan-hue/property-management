import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "theme-toggle.tsx"),
  "utf8",
);

describe("theme-toggle.tsx (source-assertion)", () => {
  it("is a client component", () => {
    expect(src).toContain('"use client"');
  });
  it("uses useTheme from next-themes", () => {
    expect(src).toContain("useTheme");
    expect(src).toContain("next-themes");
  });
  it("calls setTheme", () => {
    expect(src).toContain("setTheme");
  });
  it('has 自動 label (system)', () => {
    expect(src).toContain("自動");
  });
  it('has 明るい label (light)', () => {
    expect(src).toContain("明るい");
  });
  it('has 暗い label (dark)', () => {
    expect(src).toContain("暗い");
  });
  it("exports ThemeToggle function", () => {
    expect(src).toMatch(/export\s+function\s+ThemeToggle/);
  });
});
