import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "theme-provider.tsx"),
  "utf8",
);

describe("theme-provider.tsx (source-assertion)", () => {
  it("is a client component", () => {
    expect(src).toContain('"use client"');
  });
  it("imports ThemeProvider from next-themes", () => {
    expect(src).toContain("next-themes");
  });
  it("exports ThemeProvider function", () => {
    expect(src).toMatch(/export\s+function\s+ThemeProvider/);
  });
  it("forwards children and props to NextThemesProvider", () => {
    expect(src).toContain("children");
    expect(src).toContain("NextThemesProvider");
  });
});
